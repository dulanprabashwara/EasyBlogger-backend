const { Router } = require("express");

const authRoutes = require("./auth.routes");
const userRoutes = require("./user.routes");
const articleRoutes = require("./article.routes");
const commentRoutes = require("./comment.routes");
const messageRoutes = require("./message.routes");
const feedRoutes = require("./feed.routes");
const notificationRoutes = require("./notification.routes");
const adminRoutes = require("./admin.routes");
const aiRoutes = require("./ai.routes");
const paymentRoutes = require("./payment.routes");
const stripeRoutes = require("./stripe.routes");
const scraperRoutes = require("./scraper.routes");
const wordpressRoutes = require("./wordpress.routes");
const linkedinRoutes = require("./linkedin.routes");
const searchRoutes = require("./search.routes");
const homefeedRoutes = require("./homefeed.routes");
const articleReadRoutes = require("./articleRead.routes");
const savedArticleRoutes = require("./savedArticle.routes");
const trendingArticlesRoutes = require("./trendingArticles.routes");
const interactedArticlesroutes = require("./interactedArticles.routes");
const articleRatingRoutes = require("./articleRatings.routes");
const readHistoryRoutes = require("./readHistory.routes");
const popularTopicsRoutes = require("./popularTopics.routes");
const articleReportsRoutes = require("./articleReports.routes");
const articleStatsRoutes = require("./articleStats.routes");
const userReportsRoutes = require("./userReports.routes");
const topUserArticleRoutes = require("./topUserArticles.routes");
const supportRoutes = require("./support.routes");


const router = Router();

// ─── API Routes ─────────────────────────────
router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/articles", articleRoutes);
router.use("/comments", commentRoutes);
router.use("/messages", messageRoutes);
router.use("/feed", feedRoutes);
router.use("/notifications", notificationRoutes);
router.use("/admin", adminRoutes);
router.use("/ai", aiRoutes);
router.use("/payments", paymentRoutes);
router.use("/stripe", stripeRoutes);
router.use("/scraper", scraperRoutes);
router.use("/wordpress", wordpressRoutes);
router.use("/linkedin", linkedinRoutes);
router.use("/search", searchRoutes);
router.use("/homefeed", homefeedRoutes);
router.use("/articleRead", articleReadRoutes);
router.use("/savedArticle", savedArticleRoutes);
router.use("/trendingArticles", trendingArticlesRoutes);
router.use("/interactedArticles", interactedArticlesroutes);
router.use("/articleRatings", articleRatingRoutes);
router.use("/readHistory", readHistoryRoutes);
router.use("/popularTopics", popularTopicsRoutes);
router.use("/articleReports", articleReportsRoutes);
router.use("/articleStats", articleStatsRoutes);
router.use("/userReports", userReportsRoutes);
router.use("/topUserArticles", topUserArticleRoutes);
router.use("/support", supportRoutes);







module.exports = router;
