// @ts-nocheck
const homefeedService = require("../services/homefeed.service");

// ── getMainFeed ───────────────────────────────────────────────────────────────

exports.getMainFeed = async (req, res) => {
  try {
    const page     = parseInt(req.query.page, 10) || 1;
    const articles = await homefeedService.getPublishedMainFeed(page, 3);
    res.status(200).json(articles);
  } catch (error) {
    console.error("MAIN FEED ERROR:", error.message);
    res.status(500).json({ error: "Failed to fetch main feed" });
  }
};

// ── getFollowingFeed ──────────────────────────────────────────────────────────

exports.getFollowingFeed = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized. Please log in." });

    const page     = parseInt(req.query.page, 10) || 1;
    const articles = await homefeedService.getFollowingFeed(userId, page, 5);
    res.status(200).json(articles);
  } catch (error) {
    console.error("FOLLOWING FEED ERROR:", error.message);
    res.status(500).json({ error: "Failed to fetch following feed" });
  }
};

// ── getPersonalFeed ───────────────────────────────────────────────────────────
// AI-powered recommendation feed available to ALL logged-in users.
//
// To restrict to premium users only in the future, uncomment the isPremium check below.

exports.getPersonalFeed = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized. Please log in." });

    // ── Optional premium gate (uncomment to enable) ───────────────────────────
    // if (!req.user.isPremium) {
    //   return res.status(403).json({ error: "Personal feed is a premium feature." });
    // }

    const page   = parseInt(req.query.page, 10) || 1;
    const result = await homefeedService.getPersonalFeed(userId, page, 5);

    res.status(200).json(result);
  } catch (error) {
    console.error("PERSONAL FEED ERROR:", error.message);
    res.status(500).json({ error: "Failed to fetch personal feed" });
  }
};