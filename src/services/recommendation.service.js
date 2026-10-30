// @ts-nocheck
/**
 * recommendation.service.js
 *
 * Extracts a user's topic interest profile from their read history
 * by calling the AI (OpenRouter) and caching the result for 1 hour.
 *
 * Exposed:
 *   getUserInterestProfile(userId, historyArticles) → string[]
 *     Returns an array of topic labels (e.g. ["AI", "Startups", "Web Dev"]).
 *     Returns [] on empty history or AI failure (caller should fall back gracefully).
 */

const { CLIENTS, ENRICHMENT_MODELS } = require("./enrichment/enrichment.clients");

// ── Constants ─────────────────────────────────────────────────────────────────

const MS_PER_HOUR             = 60 * 60 * 1000;
const INTEREST_CACHE_TTL_MS   = MS_PER_HOUR;          // cache AI result for 1 hour
const CACHE_CLEANUP_INTERVAL  = 30 * 60 * 1000;       // prune expired entries every 30 min
const MAX_INTERESTS           = 8;                     // upper bound on returned topics
const MIN_HISTORY_ARTICLES    = 1;                     // minimum articles needed to run AI
const MAX_HISTORY_FOR_PROMPT  = 40;                    // cap articles sent to AI (avoid huge prompts)
const MAX_TOKENS_INTEREST     = 200;                   // small output — just a JSON array
const AI_TEMPERATURE          = 0.1;

// ── In-memory cache ───────────────────────────────────────────────────────────

// Map<userId, { interests: string[], cachedAt: number }>
const interestCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of interestCache.entries()) {
    if (now - entry.cachedAt > INTEREST_CACHE_TTL_MS) {
      interestCache.delete(userId);
    }
  }
}, CACHE_CLEANUP_INTERVAL);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Calls the AI with multi-model/multi-key fallback, same approach as the enrichment pipeline.
 * Returns the raw text content of the first successful response.
 */
async function callAI(messages) {
  let lastError;

  for (const model of ENRICHMENT_MODELS) {
    for (let ki = 0; ki < CLIENTS.length; ki++) {
      const client   = CLIENTS[ki];
      const keyLabel = ki === 0 ? "primary" : `key-${ki + 1}`;

      try {
        const completion = await client.chat.completions.create({
          model,
          messages,
          max_tokens:  MAX_TOKENS_INTEREST,
          temperature: AI_TEMPERATURE,
        });

        const content = completion.choices[0]?.message?.content || "";
        console.log(`[Recommendation] ✅ Success on ${keyLabel}/${model}`);
        return content;
      } catch (err) {
        lastError = err;
        console.warn(`[Recommendation] ${keyLabel}/${model} failed: ${err.message}`);
      }
    }
  }

  throw new Error(`[Recommendation] All AI models failed. Last: ${lastError?.message}`);
}

/**
 * Parses the AI's JSON array response, tolerating markdown fences and minor malformations.
 * Returns a string[] or [] on failure.
 */
function parseInterestArray(raw) {
  try {
    let cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const start = cleaned.indexOf("[");
    const end   = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
}

// ── getUserInterestProfile ────────────────────────────────────────────────────
//
// historyArticles: array of { title: string, tags: string[] }
//   (already loaded from ReadHistory → Article by the caller)
//
// Returns a string[] of topic labels, e.g. ["AI", "Startups", "Web Dev"].
// Returns [] if history is too short, no AI clients are configured, or the AI call fails.
//
// NOTE: To restrict this to premium users only in the future, add a
//       `isPremium` check in the homefeed controller before calling this function.

async function getUserInterestProfile(userId, historyArticles) {
  if (!userId) return [];
  if (!CLIENTS.length) {
    console.warn("[Recommendation] No AI clients available — skipping interest profile.");
    return [];
  }

  // 1. Return cached result if still fresh
  const cached = interestCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < INTEREST_CACHE_TTL_MS) {
    console.log(`[Recommendation] Cache HIT for user ${userId} (${cached.interests.length} interests)`);
    return cached.interests;
  }

  // 2. Validate we have enough history
  if (!historyArticles || historyArticles.length < MIN_HISTORY_ARTICLES) {
    console.log(`[Recommendation] Not enough history for user ${userId} — returning []`);
    return [];
  }

  // 3. Build a compact representation of the user's reading history for the prompt
  const sample = historyArticles.slice(0, MAX_HISTORY_FOR_PROMPT);
  const articlesText = sample
    .map((a) => {
      const tags  = Array.isArray(a.tags) && a.tags.length ? a.tags.join(", ") : "none";
      const title = (a.title || "").slice(0, 120); // cap title length
      return `- "${title}" [tags: ${tags}]`;
    })
    .join("\n");

  const messages = [
    {
      role:    "system",
      content: "You are a content interest classifier. Respond ONLY with a valid JSON array of strings. No explanation, no markdown, no extra text.",
    },
    {
      role:    "user",
      content:
        `Based on the following articles a user has read, identify their top ${MAX_INTERESTS} interest topics.\n\n` +
        `Articles read:\n${articlesText}\n\n` +
        `Rules:\n` +
        `- Return 3 to ${MAX_INTERESTS} short topic labels (1-3 words each)\n` +
        `- Use broad, reusable topics (e.g. "Artificial Intelligence", "Startups", "Web Development")\n` +
        `- Do NOT include article titles verbatim\n` +
        `- Respond with ONLY a JSON array: ["topic1", "topic2", ...]`,
    },
  ];

  // 4. Call AI
  let interests = [];
  try {
    console.log(`[Recommendation] Calling AI for user ${userId} (${sample.length} articles sampled)`);
    const raw = await callAI(messages);
    const parsed = parseInterestArray(raw);
    interests = parsed
      .filter((t) => typeof t === "string" && t.trim().length > 0)
      .slice(0, MAX_INTERESTS);
    console.log(`[Recommendation] AI returned interests for user ${userId}:`, interests);
  } catch (err) {
    console.error(`[Recommendation] AI call failed for user ${userId}: ${err.message}`);
    // Fall through with empty interests — caller will use fallback feed
  }

  // 5. Cache result (even empty — avoids hammering the AI if history yields no useful result)
  interestCache.set(userId, { interests, cachedAt: Date.now() });

  return interests;
}

/**
 * Invalidates the cached interest profile for a user.
 * Call this if you want to force a fresh AI classification (e.g. after bulk new reads).
 * Currently not wired to any route — available for future use.
 */
function invalidateInterestCache(userId) {
  if (interestCache.has(userId)) {
    interestCache.delete(userId);
    console.log(`[Recommendation] Cache INVALIDATED for user ${userId}`);
  }
}

module.exports = {
  getUserInterestProfile,
  invalidateInterestCache,
};
