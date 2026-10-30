// @ts-nocheck
const prisma = require("../config/prisma");
const { getUserInterestProfile } = require("./recommendation.service");

// ── Constants ──────────────────────────────────────────────────────────────────

// How many read-history articles to pull for the AI interest profile (no pagination here —
// we need the full history for an accurate classification).
const MAX_HISTORY_FOR_PROFILE = 100;

// Shared author select shape used across all feeds
const AUTHOR_SELECT = {
  author: {
    select: {
      displayName: true,
      username:    true,
      avatarUrl:   true,
      isPremium:   true,
      id:          true,
    },
  },
};

// ── getPublishedMainFeed ───────────────────────────────────────────────────────

const getPublishedMainFeed = async (page = 1, limit = 3) => {
  const skip = (page - 1) * limit;

  return await prisma.article.findMany({
    where:   { status: { in: ["PUBLISHED", "REPUBLISHED"] } },
    orderBy: { publishedAt: "desc" },
    take:    limit,
    skip,
    include: AUTHOR_SELECT,
  });
};

// ── getFollowingFeed ───────────────────────────────────────────────────────────

const getFollowingFeed = async (userId, page = 1, limit = 5) => {
  const skip = (page - 1) * limit;

  return await prisma.article.findMany({
    where: {
      status: { in: ["PUBLISHED", "REPUBLISHED"] },
      author: {
        followers: { some: { followerId: userId } },
      },
    },
    orderBy: { publishedAt: "desc" },
    take:    limit,
    skip,
    include: AUTHOR_SELECT,
  });
};

// ── getPersonalFeed ────────────────────────────────────────────────────────────
//
// AI-powered recommendation feed for the "Personal" tab.
//
// Pipeline:
//   1. Load the user's read history (titles + tags) — up to MAX_HISTORY_FOR_PROFILE articles
//   2. Call the AI (via recommendation.service) to extract a topic interest profile
//      → Result is cached per-user for 1 hour; no AI call on repeat visits
//   3. Query published articles whose tags overlap with the interest profile,
//      excluding articles the user has already read
//   4. Fall back to the standard new feed if:
//      - The user has no read history
//      - The AI returns no interests
//      - No matching articles are found
//
// NOTE: Available to ALL logged-in users. To restrict to premium users only,
//       add an isPremium check in homefeed.controller.js before calling this function.

const getPersonalFeed = async (userId, page = 1, limit = 5) => {
  const skip = (page - 1) * limit;

  // ── Step 1: Fetch user's read history ──────────────────────────────────────
  const readHistoryRaw = await prisma.readHistory.findMany({
    where:  { userId },
    take:   MAX_HISTORY_FOR_PROFILE,
    select: {
      articleId: true,
      article: {
        select: { title: true, tags: true },
      },
    },
    orderBy: { lastReadAt: "desc" },
  });

  // If user has no history at all, signal the frontend with a special flag
  if (!readHistoryRaw.length) {
    return { articles: [], noHistory: true };
  }

  const alreadyReadIds  = readHistoryRaw.map((r) => r.articleId);
  const historyArticles = readHistoryRaw.map((r) => ({
    title: r.article?.title || "",
    tags:  r.article?.tags  || [],
  }));

  // ── Step 2: Get AI interest profile (cached 1h) ────────────────────────────
  const interests = await getUserInterestProfile(userId, historyArticles);

  // ── Step 3: Query recommended articles ────────────────────────────────────
  let articles = [];

  if (interests.length > 0) {
    articles = await prisma.article.findMany({
      where: {
        status:   { in: ["PUBLISHED", "REPUBLISHED"] },
        NOT:      { id: { in: alreadyReadIds } },
        // Match any article whose tags array has at least one interest topic
        // (case-insensitive via lowercased comparison is not directly supported in Prisma,
        //  so we use `hasSome` which is case-sensitive; interests come from the same
        //  tag vocabulary so this works well in practice)
        tags:     { hasSome: interests },
      },
      orderBy: { trendingScore: "desc" },
      take:    limit,
      skip,
      include: AUTHOR_SELECT,
    });
  }

  // ── Step 4: Fallback — return recent articles if no tag matches ────────────
  if (articles.length === 0) {
    articles = await prisma.article.findMany({
      where: {
        status: { in: ["PUBLISHED", "REPUBLISHED"] },
        NOT:    { id: { in: alreadyReadIds } },
      },
      orderBy: { publishedAt: "desc" },
      take:    limit,
      skip,
      include: AUTHOR_SELECT,
    });
  }

  return {
    articles,
    noHistory:   false,
    interests,                         // expose so the frontend can show interest labels
    usingFallback: interests.length === 0,
  };
};

module.exports = {
  getPublishedMainFeed,
  getFollowingFeed,
  getPersonalFeed,
};