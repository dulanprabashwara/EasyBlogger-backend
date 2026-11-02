// @ts-nocheck
/**
 * ai.generation.service.js
 *
 * Handles the AI generation pipeline:
 *   - Session cache (short-lived in-memory store keyed by sessionId)
 *   - AI providers (Gemini → Groq → Mistral → OpenRouter) + fallback chain
 *   - analyzePrompt — extract topic + keywords from raw user input
 *   - generateArticle / regenerateArticle — produce + persist article logs
 */

const { OpenAI } = require("openai");
const { v4: uuidv4 } = require("uuid");
const KEYWORD_LIST = require("../config/keywords");
const prisma = require("../config/prisma");

// ── Constants ─────────────────────────────────────────────────────────────────

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR   = 60 * MS_PER_MINUTE;
const MS_PER_DAY    = 24 * MS_PER_HOUR;

// Session cache
const SESSION_CACHE_TTL_MS       = 2 * MS_PER_HOUR;
const SESSION_CLEANUP_INTERVAL_MS = 30 * MS_PER_MINUTE;

// AI response
const MAX_KEYWORDS_SELECTED = 10;

// Hash helper
const HASH_SHIFT_AMOUNT = 5;
const HASH_TO_INT32     = 0; // used as `hash |= HASH_TO_INT32` — converts to 32-bit int

// Reference content
const REFERENCE_ARTICLES_PER_KEYWORD        = 2;
const REFERENCE_POOL_SIZE                   = 20;
const REFERENCE_KEYWORD_OFFSET_MULTIPLIER   = 7;

// Summary excerpt length when saving/loading to the articles table
const SUMMARY_EXCERPT_LENGTH = 200;

const LENGTH_CONFIG = {
  short:        { min: 300,  max: 1000, label: "300 to 1000 words"   },
  "mid-length": { min: 1000, max: 2000, label: "1000 to 2000 words"  },
  long:         { min: 2000, max: 9999, label: "at least 2000 words" },
};

// ── AI providers ───────────────────────────────────────────────────────────────
//
// Providers are tried in this order; the first one that returns a usable
// response wins:
//   1. Google Gemini (AI Studio)  — free tier, no credit card
//   2. Groq                       — free tier, no credit card
//   3. Mistral (Experiment plan)  — free tier, phone verification only
//   4. OpenRouter                 — last-resort fallback (free models)
//
// All four expose an OpenAI-compatible API, so one SDK handles them all.
// A provider with no API key in the environment is skipped automatically.
// Model names can be overridden with comma-separated env vars (see envList)
// because free-tier catalogs change often.

const AI_TIMEOUT_MS     = Number(process.env.AI_TIMEOUT_MS)     || 40 * MS_PER_SECOND;
const ANALYZE_TIMEOUT_MS = Number(process.env.AI_ANALYZE_TIMEOUT_MS) || 15 * MS_PER_SECOND; // short JSON reply
const MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_TOKENS)     || 6000;

// How long a failing model/key is skipped after an error
const COOLDOWN_MS = {
  rateLimit: 60 * MS_PER_SECOND,   // 429
  server:    30 * MS_PER_SECOND,   // 5xx, timeouts, network
  badModel:  30 * MS_PER_MINUTE,   // 404 — model name retired/wrong
  badKey:    10 * MS_PER_MINUTE,   // 401 — key invalid or not activated (whole key skipped)
  forbidden: 10 * MS_PER_MINUTE,   // 403 — usually this model is not allowed (only this model skipped)
  badOutput: 0,                    // unparsable/empty reply — just try the next one
};

function envList(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const PROVIDER_DEFS = [
  {
    name:    "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keys:    [process.env.GEMINI_API_KEY],
    models:  envList("GEMINI_MODELS", ["gemini-2.5-flash-lite", "gemini-2.5-flash","gemini-3.5-flash-lite"]),
  },
  {
    name:    "groq",
    baseURL: "https://api.groq.com/openai/v1",
    keys:    [process.env.GROQ_API_KEY],
    models:  envList("GROQ_MODELS", ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]),
  },
  {
    name:    "mistral",
    baseURL: "https://api.mistral.ai/v1",
    keys:    [process.env.MISTRAL_API_KEY],
    models:  envList("MISTRAL_MODELS", ["mistral-small-latest"]),
  },
  {
    name:    "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    // Up to 3 OpenRouter keys; each key has its own rate-limit quota.
    keys:    [
      process.env.OPENROUTER_API_KEY,
      process.env.OPENROUTER_API_KEY_2,
      process.env.OPENROUTER_API_KEY_3,
    ],
    models:  envList("OPENROUTER_MODELS", [
      "google/gemma-4-31b-it:free",
      "google/gemma-4-26b-a4b-it:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    ]),
  },
];

// Flatten providers × models × keys into an ordered list of "slots".
function buildSlots() {
  const slots = [];
  for (const def of PROVIDER_DEFS) {
    const keys = def.keys.filter(Boolean);
    if (!keys.length) continue;

    const clients = keys.map((apiKey) =>
      new OpenAI({ baseURL: def.baseURL, apiKey, maxRetries: 0, timeout: AI_TIMEOUT_MS })
    );

    for (const model of def.models) {
      clients.forEach((client, ki) => {
        slots.push({
          id:       `${def.name}/${model}${keys.length > 1 ? `#${ki + 1}` : ""}`,
          keyId:    `${def.name}#${ki + 1}`,
          provider: def.name,
          model,
          client,
        });
      });
    }
  }
  return slots;
}

// Module-level singleton — built once when the module loads
const SLOTS = buildSlots();

if (!SLOTS.length) {
  console.warn("[AI] ⚠️  No AI provider keys found (GEMINI_API_KEY / GROQ_API_KEY / MISTRAL_API_KEY / OPENROUTER_API_KEY).");
} else {
  const active = [...new Set(SLOTS.map((s) => s.provider))].join(" → ");
  console.log(`[AI] Provider order: ${active}`);
}

// ── Session cache ──────────────────────────────────────────────────────────────

const sessionCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessionCache.entries()) {
    if (now - s.createdAt > SESSION_CACHE_TTL_MS) sessionCache.delete(id);
  }
}, SESSION_CLEANUP_INTERVAL_MS);

// ── AI helpers ─────────────────────────────────────────────────────────────────

// slot id / key id -> timestamp until which it is skipped
const cooldownUntil = new Map();

function isCoolingDown(slot) {
  const now = Date.now();
  return (cooldownUntil.get(slot.id) || 0) > now || (cooldownUntil.get(slot.keyId) || 0) > now;
}

function startCooldown(slot, err) {
  const status = err?.status;
  if (status === 401) {
    cooldownUntil.set(slot.keyId, Date.now() + COOLDOWN_MS.badKey);
    return;
  }
  let ms = COOLDOWN_MS.server;
  if (status === 403) {
    ms = COOLDOWN_MS.forbidden;
  } else if (status === 429) {
    ms = COOLDOWN_MS.rateLimit;
    const retryAfter = Number(err?.headers?.["retry-after"]);
    if (retryAfter > 0) ms = Math.min(retryAfter * MS_PER_SECOND, 5 * MS_PER_MINUTE);
  } else if (status === 404) {
    ms = COOLDOWN_MS.badModel;
  } else if (err?.code === "BAD_AI_OUTPUT") {
    ms = COOLDOWN_MS.badOutput;
  }
  if (ms > 0) cooldownUntil.set(slot.id, Date.now() + ms);
}

// Asks for JSON mode first; if the provider rejects it (HTTP 400) retries the
// same model once without it.
async function createCompletion(slot, messages, maxTokens, timeoutMs) {
  const base    = { model: slot.model, messages, max_tokens: maxTokens };
  const options = timeoutMs ? { timeout: timeoutMs } : undefined;
  try {
    return await slot.client.chat.completions.create(
      { ...base, response_format: { type: "json_object" } },
      options
    );
  } catch (err) {
    if (err?.status === 400) return slot.client.chat.completions.create(base, options);
    throw err;
  }
}

// Tries every provider/model in order and returns the first usable response.
// If `parse` is given, the reply must also parse/validate — an unparsable reply
// counts as a failure and the next provider is tried (instead of throwing later).
async function callAI(messages, { parse, maxTokens = MAX_OUTPUT_TOKENS, timeoutMs } = {}) {
  if (!SLOTS.length) {
    throw new Error("No AI provider configured. Set GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY or OPENROUTER_API_KEY.");
  }

  let lastError;
  const failures = [];

  // Pass 1 skips slots that are cooling down. If that leaves nothing to try
  // (everything recently failed), pass 2 tries them anyway.
  for (const respectCooldown of [true, false]) {
    let attempted = false;

    for (const slot of SLOTS) {
      if (respectCooldown && isCoolingDown(slot)) continue;
      attempted = true;

      try {
        const completion = await createCompletion(slot, messages, maxTokens, timeoutMs);
        const content    = completion.choices?.[0]?.message?.content || "";
        if (!content.trim()) {
          const e = new Error("empty response");
          e.code = "BAD_AI_OUTPUT";
          throw e;
        }

        let parsed;
        if (parse) {
          try {
            parsed = parse(content);
          } catch (parseErr) {
            parseErr.code = "BAD_AI_OUTPUT";
            throw parseErr;
          }
        }

        const usage = completion.usage || { prompt_tokens: 0, completion_tokens: 0 };
        console.log(`[AI] ✅ Success on ${slot.id}`);
        return { content, parsed, usage, provider: slot.id };
      } catch (err) {
        lastError = err;
        failures.push(`${slot.id}${err?.status ? ` (${err.status})` : ""}: ${String(err.message).slice(0, 120)}`);
        startCooldown(slot, err);
        console.warn(`[AI] ${slot.id} failed${err?.status ? ` (${err.status})` : ""}: ${err.message}`);
      }
    }

    if (attempted) break;
  }

  console.error(`[AI] Every provider failed:\n  ${failures.join("\n  ")}`);
  throw new Error(`All AI providers failed. Last error: ${lastError?.message || "Unknown error"}`);
}

// Escapes raw newlines/tabs/control characters that appear INSIDE JSON string
// literals (models often put real line breaks in "content"), leaving the
// whitespace between JSON tokens untouched.
function escapeControlCharsInStrings(text) {
  let out = "";
  let inString = false;
  let escaped  = false;

  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped)        { out += ch; escaped = false; continue; }
    if (ch === "\\")    { out += ch; escaped = true;  continue; }
    if (ch === '"')     { out += ch; inString = false; continue; }

    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : "";
    } else {
      out += ch;
    }
  }
  return out;
}

function parseAIJson(raw) {
  let cleaned = String(raw ?? "").replace(/^\uFEFF/, "").trim();

  // Strip ```json fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  // Keep only the outermost {...} (drops any chatter before/after the JSON)
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);

  // 1. Valid JSON as-is
  try { return JSON.parse(cleaned); } catch (_) { /* try repairs */ }

  // 2. Valid once raw control characters inside strings are escaped
  let firstError;
  try {
    return JSON.parse(escapeControlCharsInStrings(cleaned));
  } catch (e) {
    firstError = e;
  }

  // 3. Last resort for unescaped inner quotes: pull title + content out by shape
  const titleMatch = cleaned.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const keyMatch   = cleaned.match(/"content"\s*:\s*"/);
  if (titleMatch && keyMatch) {
    const body      = cleaned.slice(keyMatch.index + keyMatch[0].length);
    const lastQuote = body.lastIndexOf('"');
    if (lastQuote > 0) {
      const unescape = (s) => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      return { title: unescape(titleMatch[1]), content: unescape(body.slice(0, lastQuote)) };
    }
  }

  throw new Error(`AI returned unparseable response: ${firstError.message}`);
}

// Parser for article replies: must contain a non-empty title and content.
function parseArticleJson(raw) {
  const parsed = parseAIJson(raw);
  if (typeof parsed?.title !== "string" || typeof parsed?.content !== "string"
      || !parsed.title.trim() || !parsed.content.trim()) {
    throw new Error('AI reply is missing a non-empty "title" or "content"');
  }
  return parsed;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

// ── Reference content ──────────────────────────────────────────────────────────
//
// Fetches enriched scraped summaries for the selected keywords and passes them
// to the AI model as background context.
//
// ROTATION METHOD — user-specific, day-based:
//   Each user gets a different set of reference articles even when selecting
//   the same keyword on the same day. The offset is derived from:
//     dayOfYear + hash(authorId) + keyword position

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << HASH_SHIFT_AMOUNT) - hash) + str.charCodeAt(i);
    hash |= HASH_TO_INT32; // convert to 32-bit int
  }
  return Math.abs(hash);
}

async function fetchReferenceContent(selectedKeywords, authorId) {
  if (!selectedKeywords || selectedKeywords.length === 0) return [];

  const today     = new Date();
  const dayOfYear = Math.floor(
    (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / MS_PER_DAY
  );
  const userOffset = authorId ? simpleHash(authorId) : 0;

  const referenceItems = [];

  for (const keyword of selectedKeywords) {
    const articles = await prisma.scrapedArticle.findMany({
      where:   { matchedKeywords: { has: keyword }, summary: { not: null } },
      orderBy: { scrapedAt: "desc" },
      select:  { id: true, title: true, summary: true },
      take:    REFERENCE_POOL_SIZE,
    });

    if (articles.length === 0) {
      console.log(`[AI][Reference] keyword="${keyword}" → 0 scraped summaries found`);
      continue;
    }

    const keywordPos    = selectedKeywords.indexOf(keyword);
    const finalOffset   = (dayOfYear + userOffset + keywordPos * REFERENCE_KEYWORD_OFFSET_MULTIPLIER) % articles.length;
    let fetchedForKeyword = 0;

    for (let i = 0; i < REFERENCE_ARTICLES_PER_KEYWORD; i++) {
      const article = articles[(finalOffset + i) % articles.length];
      if (article?.summary) {
        referenceItems.push({ keyword, title: article.title, summary: article.summary });
        fetchedForKeyword++;
      }
    }

    console.log(
      `[AI][Reference] keyword="${keyword}" → ${fetchedForKeyword}/${REFERENCE_ARTICLES_PER_KEYWORD} ` +
      `scraped summaries fetched (pool size: ${articles.length})`
    );
  }

  if (selectedKeywords.length > 0) {
    console.log(
      `[AI][Reference] Total reference summaries: ${referenceItems.length}/` +
      `${selectedKeywords.length * REFERENCE_ARTICLES_PER_KEYWORD} across ${selectedKeywords.length} keyword(s)`
    );
  }

  return referenceItems;
}

function buildReferenceBlock(referenceItems) {
  if (referenceItems.length === 0) return "";

  const lines = referenceItems.map((item, i) =>
    `[REF ${i + 1}] Topic: ${item.keyword}\nTitle: ${item.title}\nSummary: ${item.summary}`
  );

  return (
    `\n\nREFERENCE MATERIALS (background context from current web content):\n` +
    `IMPORTANT RULES for using these references:\n` +
    `- The user's idea, tone, and length instructions come FIRST — always\n` +
    `- Only use a reference if it is clearly relevant to the user's topic\n` +
    `- Use references for IDEAS and FACTS only — never copy wording\n` +
    `- Rewrite every piece of information entirely in your own words\n` +
    `- Do not follow the structure or paragraph order of any reference\n` +
    `- The final article must read as fully original writing, not a summary of these sources\n\n` +
    lines.join("\n\n")
  );
}

// ── Shared generation core ─────────────────────────────────────────────────────
//
// Both generateArticle and regenerateArticle share the same:
//   - session resolution, length/tone config, reference fetching
//   - AI call + word-count correction loop
//   - log persistence


async function _buildAndSaveArticle({
  sessionId,
  directInput,
  selectedKeywords,
  articleLength,
  tone,
  authorId,
  systemPrompt,
  userPromptPrefix,
  initialInputTokens  = 0,
  initialOutputTokens = 0,
}) {
  const session   = sessionId && sessionCache.has(sessionId) ? sessionCache.get(sessionId) : null;
  const userInput = session?.userInput ?? directInput;
  if (!userInput?.trim()) throw new Error("No prompt available. Please start over.");

  const storedLength      = session?.hasLengthInPrompt ? null : (articleLength || "short");
  const storedTone        = session?.hasToneInPrompt   ? null : (tone || "professional");
  const keywordsPresented = session?.keywordsPresented ?? [];
  const keywordsSelected  = selectedKeywords ?? [];
  const lengthConfig      = LENGTH_CONFIG[articleLength] || LENGTH_CONFIG.short;
  const articleTone       = tone || "professional";
  const subtopicsList     = keywordsSelected.length
    ? keywordsSelected.join(", ")
    : "none — generate based on user prompt alone";

  const referenceItems = await fetchReferenceContent(keywordsSelected, authorId);
  const referenceBlock = buildReferenceBlock(referenceItems);

  const buildMessages = (extra = "") => [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content:
        `${userPromptPrefix}\n` +
        `Idea: "${userInput}"\n` +
        `Subtopics: ${subtopicsList}\n` +
        `Length: ${lengthConfig.label}\n` +
        `Tone: ${articleTone}\n` +
        `${extra}` +
        `${referenceBlock}\n\n` +
        `Respond ONLY with: {"title":"...","content":"..."}`,
    },
  ];

  let totalInputTokens  = initialInputTokens;
  let totalOutputTokens = initialOutputTokens;

  const { parsed: firstDraft, usage: u1 } = await callAI(buildMessages(), { parse: parseArticleJson });
  totalInputTokens  += u1.prompt_tokens     || 0;
  totalOutputTokens += u1.completion_tokens || 0;

  let parsed    = firstDraft;
  let wordCount = countWords(parsed.content);

  if (wordCount < lengthConfig.min || (articleLength !== "long" && wordCount > lengthConfig.max)) {
    const correction = wordCount < lengthConfig.min
      ? `IMPORTANT: Too short (${wordCount} words). Must be at least ${lengthConfig.min} words.\n`
      : `IMPORTANT: Too long (${wordCount} words). Must be under ${lengthConfig.max} words.\n`;
    try {
      const { parsed: corrected, usage: u2 } = await callAI(buildMessages(correction), { parse: parseArticleJson });
      totalInputTokens  += u2.prompt_tokens     || 0;
      totalOutputTokens += u2.completion_tokens || 0;
      parsed    = corrected;
      wordCount = countWords(parsed.content);
    } catch (retryErr) {
      // Keep the first draft rather than failing the whole request
      console.warn(`[AI] Length-correction retry failed, keeping first draft: ${retryErr.message}`);
    }
  }

  let logId = null;
  try {
    const log = await prisma.ai_article_logs.create({
      data: {
        id:             uuidv4(),
        authorId,
        userPrompt:     userInput,
        keywordsPresented,
        keywordsSelected,
        articleLength:  storedLength,
        tone:           storedTone,
        articleTitle:   parsed.title,
        articleContent: parsed.content,
        wordCount,
        aiInputTokens:  totalInputTokens,
        aiOutputTokens: totalOutputTokens,
      },
    });
    logId = log.id;
  } catch (dbErr) {
    console.error("[AI] Failed to save to ai_article_logs:", dbErr.message);
  }

  return { title: parsed.title, content: parsed.content, wordCount, logId };
}

// ── analyzePrompt ──────────────────────────────────────────────────────────────

async function analyzePrompt(userInput) {
  const messages = [
    {
      role: "system",
      content: "You are an assistant for a blogging platform. Respond with ONLY valid JSON. No markdown, no extra text.",
    },
    {
      role: "user",
      content:
        `Analyze this blog article idea: "${userInput}"\n\n` +
        `KEYWORD LIST (only select from this list exactly):\n${KEYWORD_LIST.join(", ")}\n\n` +
        `Tasks:\n` +
        `1. Identify main topic\n` +
        `2. Select 5-10 matching keywords from the list only\n` +
        `3. Detect if prompt mentions article LENGTH (short/long/word count etc)\n` +
        `4. Detect if prompt mentions TONE (professional/casual/humorous etc)\n\n` +
        `Respond ONLY with:\n` +
        `{"topic":"...","keywords":[...],"hasArticleLengthInPrompt":false,"hasToneInPrompt":false}`,
    },
  ];

  const { parsed, usage } = await callAI(messages, { parse: parseAIJson, maxTokens: 2500, timeoutMs: ANALYZE_TIMEOUT_MS });
  const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, MAX_KEYWORDS_SELECTED) : [];

  const sessionId = uuidv4();
  sessionCache.set(sessionId, {
    userInput,
    keywordsPresented:   keywords,
    hasLengthInPrompt:   Boolean(parsed.hasArticleLengthInPrompt),
    hasToneInPrompt:     Boolean(parsed.hasToneInPrompt),
    createdAt:           Date.now(),
    analyzeInputTokens:  usage.prompt_tokens     || 0,
    analyzeOutputTokens: usage.completion_tokens || 0,
  });

  return {
    sessionId,
    topic:                    parsed.topic || "",
    keywords,
    hasArticleLengthInPrompt: Boolean(parsed.hasArticleLengthInPrompt),
    hasToneInPrompt:          Boolean(parsed.hasToneInPrompt),
  };
}

// ── generateArticle ────────────────────────────────────────────────────────────

async function generateArticle({ sessionId, userInput: directInput, selectedKeywords, articleLength, tone, authorId }) {
  const session = sessionId && sessionCache.has(sessionId) ? sessionCache.get(sessionId) : null;

  return _buildAndSaveArticle({
    sessionId,
    directInput,
    selectedKeywords,
    articleLength,
    tone,
    authorId,
    systemPrompt:
      "You are an expert blog writer creating 100% original content.\n\n" +
      "PRIORITY ORDER (follow strictly):\n" +
      "1. USER'S IDEA — write about exactly what the user described\n" +
      "2. LENGTH and TONE instructions — follow precisely\n" +
      "3. REFERENCE MATERIALS — use only if relevant, only for facts/ideas, NEVER copy wording\n\n" +
      "PLAGIARISM RULES (non-negotiable):\n" +
      "- Write every sentence in your own unique voice\n" +
      "- Never reproduce phrases or sentence structures from reference materials\n" +
      "- Do not follow the structure of any reference article\n" +
      "- All statistics, claims, and ideas from references must be rewritten completely\n" +
      "- The article must pass plagiarism checks — it must read as original writing\n\n" +
      "Respond with ONLY valid JSON. No markdown, no extra text.",
    userPromptPrefix:    "Write a blog article:",
    initialInputTokens:  session?.analyzeInputTokens  || 0,
    initialOutputTokens: session?.analyzeOutputTokens || 0,
  });
}

// ── regenerateArticle ──────────────────────────────────────────────────────────

async function regenerateArticle({ sessionId, userInput: directInput, selectedKeywords, articleLength, tone, authorId }) {
  return _buildAndSaveArticle({
    sessionId,
    directInput,
    selectedKeywords,
    articleLength,
    tone,
    authorId,
    systemPrompt:
      "You are an expert blog writer creating 100% original content. " +
      "Write a DIFFERENT version — new title, new angle, fresh structure.\n\n" +
      "PRIORITY ORDER:\n" +
      "1. USER'S IDEA — write about exactly what the user described\n" +
      "2. LENGTH and TONE — follow precisely\n" +
      "3. REFERENCE MATERIALS — use only if relevant, only for facts/ideas, NEVER copy wording\n\n" +
      "PLAGIARISM RULES: Write every sentence in your own voice. Never reproduce phrasing from references. " +
      "All content must be original. Respond with ONLY valid JSON.",
    userPromptPrefix:    "Write a FRESH, DIFFERENT article:",
    initialInputTokens:  0,
    initialOutputTokens: 0,
  });
}

module.exports = {
  sessionCache,
  analyzePrompt,
  generateArticle,
  regenerateArticle,
  SUMMARY_EXCERPT_LENGTH,
};
