// @ts-nocheck
const prisma = require("../config/prisma");

// ── CONSTANTS ───────────────────────────────────────────────────────

const DEFAULT_SEARCH_LIMIT          = 10;
const TITLE_MATCH_LIMIT             = 50;
const TAG_MATCH_LIMIT               = 50;
const SUMMARY_MATCH_LIMIT           = 50;
const AUTOCOMPLETE_ARTICLES_LIMIT   = 5;
const AUTOCOMPLETE_USERS_LIMIT      = 3;
const AUTOCOMPLETE_MIN_QUERY_LENGTH = 2;
const ENGAGEMENT_RATING_MULTIPLIER  = 10;
const ENGAGEMENT_COMMENT_MULTIPLIER = 2;
const FOLLOWER_ARTICLE_MULTIPLIER   = 10;
const SEARCH_RESULTS_MULTIPLIER     = 5;
const MIN_SEARCH_RESULTS_FETCH      = 50;

// ── HELPERS ─────────────────────────────────────────────────────────

// Escapes special regex characters so user input is safe for use in RegExp constructor.
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Computes a weighted engagement score from ratings, reads, and comments.
const computeEngagement = (article) =>
  (article.averageRating || 0) * (article.ratingCount || 0) * ENGAGEMENT_RATING_MULTIPLIER +
  (article.readCount     || 0) +
  (article.commentCount  || 0) * ENGAGEMENT_COMMENT_MULTIPLIER;

// Returns a copy of the articles array sorted by descending engagement score.
const sortByEngagement = (articles) =>
  [...articles].sort((a, b) => computeEngagement(b) - computeEngagement(a));

const ARTICLE_AUTHOR_SELECT = {
  author: {
    select: {
      id:          true,
      username:    true,
      displayName: true,
      avatarUrl:   true,
      isPremium:   true,
    },
  },
  _count: { select: { comments: true } },
};

// Fetches IDs of published articles whose tags exactly match the query (case-insensitive),
// excluding any already-seen IDs. Two overloads handle the empty-exclusion-list edge case
// to avoid passing an empty array to ANY(), which some PostgreSQL drivers reject.
const fetchTagMatchIds = (excludeIds, q) =>
  excludeIds.length > 0
    ? prisma.$queryRaw`
        SELECT id FROM articles
        WHERE status = 'PUBLISHED'
        AND id != ALL(${excludeIds})
        AND EXISTS (SELECT 1 FROM unnest(tags) AS t WHERE lower(t) = lower(${q}))
        LIMIT ${TAG_MATCH_LIMIT}`
    : prisma.$queryRaw`
        SELECT id FROM articles
        WHERE status = 'PUBLISHED'
        AND EXISTS (SELECT 1 FROM unnest(tags) AS t WHERE lower(t) = lower(${q}))
        LIMIT ${TAG_MATCH_LIMIT}`;

// Counts published articles matched by tag only, excluding already-seen IDs.
const countTagOnly = (excludeIds, q) =>
  excludeIds.length > 0
    ? prisma.$queryRaw`
        SELECT COUNT(*)::int AS count FROM articles
        WHERE status = 'PUBLISHED'
        AND id != ALL(${excludeIds})
        AND EXISTS (SELECT 1 FROM unnest(tags) AS t WHERE lower(t) = lower(${q}))`
    : prisma.$queryRaw`
        SELECT COUNT(*)::int AS count FROM articles
        WHERE status = 'PUBLISHED'
        AND EXISTS (SELECT 1 FROM unnest(tags) AS t WHERE lower(t) = lower(${q}))`;

// ── SEARCH ARTICLES ─────────────────────────────────────────────────

// Searches published articles using a four-tier ranking:
//   Tier 1 — title contains the query as an exact whole word
//   Tier 2 — any tag exactly equals the query (case-insensitive)
//   Tier 3 — summary contains the query as an exact whole word
//   Tier 4 — title contains the query as a substring
// Each tier is sorted by engagement before merging. Returns a paginated result
// with isSaved flags stamped on each article when currentUserId is provided.
const searchArticles = async ({ query, page = 1, limit = DEFAULT_SEARCH_LIMIT, currentUserId = null }) => {
  const q = (query || "").trim();
  if (!q) return { articles: [], total: 0, page, limit, totalPages: 0 };

  const publishedFilter = { status: { in: ["PUBLISHED", "REPUBLISHED"] } };
  const exactWordRegex  = new RegExp(`\\b${escapeRegex(q)}\\b`, "i");

  const titleMatches = await prisma.article.findMany({
    where:   { ...publishedFilter, title: { contains: q, mode: "insensitive" } },
    include: ARTICLE_AUTHOR_SELECT,
    take:    TITLE_MATCH_LIMIT,
  });

  const titleIds     = titleMatches.map((a) => a.id);
  const tagMatchRows = await fetchTagMatchIds(titleIds, q);
  const tagMatchIds  = tagMatchRows.map((r) => r.id);

  const tagMatches = tagMatchIds.length > 0
    ? await prisma.article.findMany({ where: { id: { in: tagMatchIds } }, include: ARTICLE_AUTHOR_SELECT })
    : [];

  const allExcludedIds = [...titleIds, ...tagMatchIds];
  const summaryMatches = await prisma.article.findMany({
    where: {
      ...publishedFilter,
      summary: { contains: q, mode: "insensitive" },
      ...(allExcludedIds.length > 0 && { NOT: { id: { in: allExcludedIds } } }),
    },
    include: ARTICLE_AUTHOR_SELECT,
    take:    SUMMARY_MATCH_LIMIT,
  });

  const summaryExactMatches = summaryMatches.filter((a) => a.summary && exactWordRegex.test(a.summary));

  const summaryOnlyCount = await prisma.article.count({
    where: {
      ...publishedFilter,
      summary: { contains: q, mode: "insensitive" },
      ...(allExcludedIds.length > 0 && { NOT: { id: { in: allExcludedIds } } }),
    },
  });

  const [titleTotal, tagOnlyTotalRows] = await Promise.all([
    prisma.article.count({ where: { ...publishedFilter, title: { contains: q, mode: "insensitive" } } }),
    countTagOnly(titleIds, q),
  ]);
  const total = titleTotal + Number(tagOnlyTotalRows[0]?.count ?? 0) + summaryOnlyCount;

  // Tier 4 candidates whose summary also contains an exact word match are promoted to tier 3.
  const tier1           = titleMatches.filter((a) =>  exactWordRegex.test(a.title));
  const tier4Candidates = titleMatches.filter((a) => !exactWordRegex.test(a.title));
  const promotedToTier3 = tier4Candidates.filter((a) => a.summary && exactWordRegex.test(a.summary));
  const tier4           = tier4Candidates.filter((a) => !a.summary || !exactWordRegex.test(a.summary));

  const merged    = [
    ...sortByEngagement(tier1),
    ...sortByEngagement(tagMatches),
    ...sortByEngagement([...summaryExactMatches, ...promotedToTier3]),
    ...sortByEngagement(tier4),
  ];
  const skip      = (page - 1) * limit;
  const paginated = merged.slice(skip, skip + limit);

  // Bulk-checks saved state for the logged-in user in a single query.
  let savedSet = new Set();
  if (currentUserId && paginated.length > 0) {
    const saved = await prisma.savedArticle.findMany({
      where:  { userId: currentUserId, articleId: { in: paginated.map((a) => a.id) } },
      select: { articleId: true },
    });
    savedSet = new Set(saved.map((s) => s.articleId));
  }

  const articles = paginated.map((a) => ({
    ...a,
    ...(currentUserId !== null && { isSaved: savedSet.has(a.id) }),
  }));

  return { articles, total, page, limit, totalPages: Math.ceil(total / limit) };
};

// ── SEARCH USERS ────────────────────────────────────────────────────

// Searches users by username or displayName, ranked by follower score
// (totalFollowers + articleCount × FOLLOWER_ARTICLE_MULTIPLIER).
// Stamps isFollowing on each result when currentUserId is provided.
const searchUsers = async ({ query, page = 1, limit = DEFAULT_SEARCH_LIMIT, currentUserId = null }) => {
  const q = (query || "").trim();
  if (!q) return { users: [], total: 0, page, limit, totalPages: 0 };

  const nameFilter = {
    OR: [
      { username:    { contains: q, mode: "insensitive" } },
      { displayName: { contains: q, mode: "insensitive" } },
    ],
  };

  const [rawUsers, total] = await Promise.all([
    prisma.user.findMany({
      where:  nameFilter,
      select: {
        id:          true,
        username:    true,
        displayName: true,
        avatarUrl:   true,
        bio:         true,
        isPremium:   true,
        stats:  { select: { totalFollowers: true, articleCount: true } },
        _count: { select: { articles: true, followers: true } },
      },
      take: Math.max(limit * SEARCH_RESULTS_MULTIPLIER, MIN_SEARCH_RESULTS_FETCH),
    }),
    prisma.user.count({ where: nameFilter }),
  ]);

  // Ranks users by a combined follower + article score.
  const followerScore = (u) =>
    (u.stats?.totalFollowers ?? u._count?.followers ?? 0) +
    (u.stats?.articleCount   ?? u._count?.articles  ?? 0) * FOLLOWER_ARTICLE_MULTIPLIER;

  const sorted    = [...rawUsers].sort((a, b) => followerScore(b) - followerScore(a));
  const skip      = (page - 1) * limit;
  const paginated = sorted.slice(skip, skip + limit);

  // Bulk-checks follow state for the logged-in user in a single query.
  let followingSet = new Set();
  if (currentUserId && paginated.length > 0) {
    const checkIds = paginated.map((u) => u.id).filter((id) => id !== currentUserId);
    if (checkIds.length > 0) {
      const follows = await prisma.follow.findMany({
        where:  { followerId: currentUserId, followingId: { in: checkIds } },
        select: { followingId: true },
      });
      followingSet = new Set(follows.map((f) => f.followingId));
    }
  }

  const users = paginated.map((u) => ({
    ...u,
    ...(currentUserId !== null && { isFollowing: followingSet.has(u.id) }),
  }));

  return { users, total, page, limit, totalPages: Math.ceil(total / limit) };
};

// ── AUTOCOMPLETE SUGGESTIONS ────────────────────────────────────────

// Returns up to AUTOCOMPLETE_ARTICLES_LIMIT article suggestions (title-first, then tag-fills)
// and up to AUTOCOMPLETE_USERS_LIMIT user suggestions for a partial query.
// Requires a minimum query length of AUTOCOMPLETE_MIN_QUERY_LENGTH characters.
const getSearchSuggestions = async (query) => {
  const q = (query || "").trim();
  if (q.length < AUTOCOMPLETE_MIN_QUERY_LENGTH) return { articles: [], users: [] };

  // Fire both queries in parallel — users result is independent of article results.
  const [titleSuggestions, users] = await Promise.all([
    prisma.article.findMany({
      where:   { status: "PUBLISHED", title: { contains: q, mode: "insensitive" } },
      select:  { id: true, title: true, slug: true },
      orderBy: [{ averageRating: "desc" }, { ratingCount: "desc" }],
      take:    AUTOCOMPLETE_ARTICLES_LIMIT,
    }),
    prisma.user.findMany({
      where: {
        OR: [
          { username:    { contains: q, mode: "insensitive" } },
          { displayName: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
      take:   AUTOCOMPLETE_USERS_LIMIT,
    }),
  ]);

  // Fills remaining article slots with tag-matched articles not already shown.
  // This step depends on titleSuggestions so it must run after the parallel step.
  let tagSuggestions = [];
  const remaining = AUTOCOMPLETE_ARTICLES_LIMIT - titleSuggestions.length;
  if (remaining > 0) {
    const titleSuggestionIds = titleSuggestions.map((a) => a.id);
    const tagRows = await fetchTagMatchIds(titleSuggestionIds, q);
    const tagIds  = tagRows.map((r) => r.id).slice(0, remaining);
    if (tagIds.length > 0) {
      tagSuggestions = await prisma.article.findMany({
        where:   { id: { in: tagIds } },
        select:  { id: true, title: true, slug: true },
        orderBy: [{ averageRating: "desc" }, { ratingCount: "desc" }],
      });
    }
  }

  return { articles: [...titleSuggestions, ...tagSuggestions], users };
};

module.exports = { searchArticles, searchUsers, getSearchSuggestions };
