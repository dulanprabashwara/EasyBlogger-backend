// @ts-nocheck
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = require("../config/prisma");
const ApiError = require("../utils/ApiError");
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ─── Dashboard ──────────────────────────────

const getLast30Days = () => {
  const dates = [];
  const startDates = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    startDates.push(new Date(d));
    dates.push(`${d.getMonth() + 1}/${d.getDate()}`);
  }
  return { labels: dates, rawDates: startDates };
};

const calculateEngagement = async (days) => {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const records = await prisma.user.findMany({
    where: {
      createdAt: {
        gte: startDate,
      },
    },
    select: {
      createdAt: true,
    },
  });

  const engagementMap = {};
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateString = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    engagementMap[dateString] = 0;
  }

  records.forEach((record) => {
    const dateString = record.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (engagementMap[dateString] !== undefined) {
      engagementMap[dateString] += 1;
    }
  });

  const labels = Object.keys(engagementMap);
  const values = Object.values(engagementMap);

  return {
    labels: labels,
    values: values
  };
};

const getDashboard = async () => {

  let dashboard = await prisma.adminDashboard.findUnique({
    where: { id: "singleton" },
  });

  if (!dashboard) {
    dashboard = await prisma.adminDashboard.create({
      data: { id: "singleton" },
    });
  }

  const { labels, rawDates } = getLast30Days();
  const thirtyDaysAgo = rawDates[0];

  const [recentComments, recentRatings, recentReads] = await Promise.all([
    prisma.comment.findMany({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.articleRating.findMany({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.readHistory.findMany({ where: { lastReadAt: { gte: thirtyDaysAgo } } })
  ]);

  const chartDatasets = {
    comments: new Array(30).fill(0),
    ratings: new Array(30).fill(0),
    reads: new Array(30).fill(0)
  };

  const sortIntoDays = (items, dateField, targetArray) => {
    items.forEach(item => {
      const itemDate = new Date(item[dateField]);
      itemDate.setHours(0, 0, 0, 0);

      const dayIndex = rawDates.findIndex(d => d.getTime() === itemDate.getTime());
      if (dayIndex !== -1) {
        targetArray[dayIndex] += 1;
      }
    });
  };

  sortIntoDays(recentComments, 'createdAt', chartDatasets.comments);
  sortIntoDays(recentRatings, 'createdAt', chartDatasets.ratings);
  sortIntoDays(recentReads, 'lastReadAt', chartDatasets.reads);

  return {
    kpis: {
      pendingReports: await prisma.reportedArticle.count({ where: { status: 'PENDING' } }),
      activePremiumUsers: dashboard.premiumUsers,
      totalUsers: dashboard.totalUsers,
      dailyEngagement: recentComments.length + recentRatings.length
    },
    chartData: {
      labels: labels,
      datasets: chartDatasets
    }
  };
};


const refreshDashboard = async () => {
  const [totalUsers, totalArticles, premiumUsers] = await Promise.all([
    prisma.user.count(),
    prisma.article.count({ where: { status: "PUBLISHED" } }),
    prisma.user.count({ where: { isPremium: true } }),
  ]);

  const dashboard = await prisma.adminDashboard.upsert({
    where: { id: "singleton" },
    update: { totalUsers, totalArticles, premiumUsers },
    create: { id: "singleton", totalUsers, totalArticles, premiumUsers },
  });

  return await getDashboard();
};

const getAdvancedAnalytics = async () => {
  //User Demographics (Donut Chart)
  const totalUsers = await prisma.user.count();
  const premiumUsers = await prisma.user.count({ where: { isPremium: true } });
  const regularUsers = totalUsers - premiumUsers;

  const bannedUsers = await prisma.bannedUser.count();
  const activeUsers = totalUsers - bannedUsers;

  // Content Usage & Engagement (Radar Chart)
  const [totalReads, totalComments, totalRatings, totalShares] = await Promise.all([
    prisma.readHistory.count(),
    prisma.comment.count(),
    prisma.articleRating.count(),
    prisma.articleShare.count()
  ]);

  // Revenue & Growth
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const recentUsers = await prisma.user.findMany({
    where: { createdAt: { gte: sixMonthsAgo } },
    select: { createdAt: true }
  });

  // Group the signups by month (e.g., 'Jan', 'Feb')
  const monthlyGrowth = {};
  recentUsers.forEach(user => {
    const month = user.createdAt.toLocaleString('en-US', { month: 'short' });
    monthlyGrowth[month] = (monthlyGrowth[month] || 0) + 1;
  });

  return {
    demographics: {
      premium: premiumUsers,
      regular: regularUsers,
      banned: bannedUsers,
      active: activeUsers
    },
    usage: {
      reads: totalReads,
      comments: totalComments,
      ratings: totalRatings,
      shares: totalShares
    },
    growth: {
      labels: Object.keys(monthlyGrowth),
      values: Object.values(monthlyGrowth)
    }
  };
};

// ─── User Management ────────────────────────

const listUsers = async ({ page = 1, limit = 20, role, isPremium, search }) => {
  const skip = (page - 1) * limit;
  const where = {};

  if (role) where.role = role;
  if (isPremium !== undefined) where.isPremium = isPremium;
  if (search) {
    where.OR = [
      { username: { contains: search, mode: Prisma.QueryMode.insensitive } },
      { email: { contains: search, mode: Prisma.QueryMode.insensitive } },
      { displayName: { contains: search, mode: Prisma.QueryMode.insensitive } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        role: true,
        isPremium: true,
        isOnline: true,
        createdAt: true,
        bannedRecord: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return { users, total };
};

const updateUserRole = async (adminId, targetUserId, newRole) => {
  if (adminId === targetUserId) {
    throw ApiError.badRequest("You cannot change your own role.");
  }

  const user = await prisma.user.update({
    where: { id: targetUserId },
    data: { role: newRole },
  });

  await prisma.auditLog.create({
    data: {
      adminId,
      action: "UPDATE_ROLE",
      targetId: targetUserId,
      targetType: "User",
      details: JSON.stringify({ newRole }),
    },
  });

  return user;
};

// ─── Ban Management ─────────────────────────

const banUser = async (adminId, targetUserId, reason, bannedUntil = null) => {
  if (adminId === targetUserId) {
    throw ApiError.badRequest("You cannot ban yourself.");
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { bannedRecord: true },
  });

  if (!targetUser) throw ApiError.notFound("User not found.");
  if (targetUser.role === "ADMIN")
    throw ApiError.forbidden("Cannot ban an admin.");
  if (targetUser.bannedRecord)
    throw ApiError.conflict("User is already banned.");

  const ban = await prisma.bannedUser.create({
    data: {
      userId: targetUserId,
      bannedById: adminId,
      reason,
      bannedUntil: bannedUntil ? new Date(bannedUntil) : null,
    },
  });

  await prisma.auditLog.create({
    data: {
      adminId,
      action: "BAN_USER",
      targetId: targetUserId,
      targetType: "User",
      details: JSON.stringify({ reason, bannedUntil }),
    },
  });

  return ban;
};

const unbanUser = async (adminId, targetUserId) => {
  const ban = await prisma.bannedUser.findUnique({
    where: { userId: targetUserId },
  });

  if (!ban) throw ApiError.notFound("User is not banned.");

  await prisma.bannedUser.delete({ where: { userId: targetUserId } });

  await prisma.auditLog.create({
    data: {
      adminId,
      action: "UNBAN_USER",
      targetId: targetUserId,
      targetType: "User",
    },
  });

  return { unbanned: true };
};

// ─── Content Moderation ─────────────────────

const getReports = async ({ page = 1, limit = 20, status }) => {
  const skip = (page - 1) * limit;
  const where = {};
  if (status) where.status = status;

  const [reports, total] = await Promise.all([
    prisma.reportedArticle.findMany({
      where,
      include: {
        article: {
          select: { id: true, title: true, slug: true, authorId: true, content: true, coverImage: true },
        },
        reporter: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.reportedArticle.count({ where }),
  ]);

  return { reports, total };
};

const reportArticle = async (reporterId, articleId, reason, details = null) => {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) throw ApiError.notFound("Article not found.");

  const report = await prisma.reportedArticle.create({
    data: {
      reporterId,
      articleId,
      reason,
      details,
    },
  });

  return report;
};

const resolveReport = async (adminId, reportId, newStatus) => {
  const report = await prisma.reportedArticle.update({
    where: { id: reportId },
    data: {
      status: newStatus,
      resolvedAt: new Date(),
    },
  });

  if (newStatus === "RESOLVED" && report.articleId) {
    await prisma.article.update({
      where: { id: report.articleId },
      data: { status: "DRAFT" },
    });
  }

  await prisma.auditLog.create({
    data: {
      adminId,
      action: "RESOLVE_REPORT",
      targetId: reportId,
      targetType: "ReportedArticle",
      details: JSON.stringify({ newStatus }),
    },
  });

  return report;
};

// ─── Audit Logs ─────────────────────────────

const getAuditLogs = async ({ page = 1, limit = 50, adminId, action }) => {
  const skip = (page - 1) * limit;
  const where = {};
  if (adminId) where.adminId = adminId;
  if (action) where.action = action;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        admin: {
          select: { id: true, username: true, displayName: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total };
};

// ─── AI Config ──────────────────────────────

const getAiConfig = async () => {
  let config = await prisma.aiConfig.findUnique({ where: { id: "singleton" } });

  if (!config) {
    config = await prisma.aiConfig.create({ data: { id: "singleton" } });
  }

  return config;
};

const updateAiConfig = async (adminId, data) => {
  const { modelName, apiUsageLimit, isEnabled } = data;

  const config = await prisma.aiConfig.upsert({
    where: { id: "singleton" },
    update: {
      ...(modelName && { modelName }),
      ...(apiUsageLimit !== undefined && { apiUsageLimit }),
      ...(isEnabled !== undefined && { isEnabled }),
    },
    create: { id: "singleton", ...data },
  });

  await prisma.auditLog.create({
    data: {
      adminId,
      action: "UPDATE_AI_CONFIG",
      targetId: "singleton",
      targetType: "AiConfig",
      details: JSON.stringify(data),
    },
  });

  return config;
};

// ─── Trending ───────────────────────────────

const getTrendingTopics = async (limit = 20) => {
  return prisma.trendingTopic.findMany({
    orderBy: { hitCount: "desc" },
    take: limit,
  });
};

const incrementTopicHit = async (topicName) => {
  await prisma.trendingTopic.upsert({
    where: { name: topicName.toLowerCase() },
    update: { hitCount: { increment: 1 } },
    create: { name: topicName.toLowerCase(), hitCount: 1 },
  });
};

const getAllOffers = async () => {
  return await prisma.offer.findMany({
    orderBy: { createdAt: 'desc' }
  });
};

const createOffer = async (data, adminId) => {
  const { name, discount_percent, stripe_coupon_id, is_active } = data;

  if (!stripe_coupon_id) {
    throw new Error("Stripe Coupon ID is required to create an offer.");
  }
  try {
    await stripe.coupons.retrieve(stripe_coupon_id);
  } catch (error) {
    throw new Error(`Invalid Stripe Coupon: '${stripe_coupon_id}' does not exist in your Stripe account.`);
  }

  const offer = await prisma.offer.create({
    data: {
      name: data.name,
      discount_percent: discount_percent,
      stripe_coupon_id: stripe_coupon_id,
      is_active: is_active,
    }
  });

  await prisma.auditLog.create({
    data: {
      action: "CREATE_OFFER",
      targetId: offer.id,
      targetType: "Offer",
      adminId,
      details: `Created automated Stripe offer: ${offer.name}`
    }
  });

  return offer;
};

const updateOffer = async (id, data, adminId) => {
  const { name, discount_percent, stripe_coupon_id, is_active } = data;

  const offer = await prisma.offer.update({
    where: { id: id },
    data: {
      name: data.name,
      discount_percent: data.discount_percent,
      stripe_coupon_id: stripe_coupon_id,
      is_active: is_active,
    }
  });

  await prisma.auditLog.create({
    data: { action: "UPDATE_OFFER", targetId: offer.id, targetType: "Offer", adminId, details: `Updated offer: ${offer.name}` }
  });
  return offer;
};

const getScrapingSources = async () => {
  return await prisma.scrapingSource.findMany({
    orderBy: { createdAt: 'desc' }
  });
};

const createScrapingSource = async (data, adminId) => {
  const source = await prisma.scrapingSource.create({
    data: {
      name: data.name,
      url: data.url,
      category: data.category,
      scrapeWindow: data.scrapeWindow,
      minWordCount: parseInt(data.minWordCount) || 300,
      excludedKeywords: data.excludedKeywords || [],
      status: data.status || "active"
    }
  });

  await prisma.auditLog.create({
    data: { action: "CREATE_SCRAPING_SOURCE", targetId: source.id, targetType: "ScrapingSource", adminId, details: `Added source: ${source.name}` }
  });
  return source;
};

const updateScrapingSource = async (id, data, adminId) => {
  const source = await prisma.scrapingSource.update({
    where: { id: id },
    data: {
      name: data.name,
      url: data.url,
      category: data.category,
      scrapeWindow: data.scrapeWindow,
      minWordCount: parseInt(data.minWordCount) || 300,
      excludedKeywords: data.excludedKeywords || [],
      status: data.status
    }
  });

  await prisma.auditLog.create({
    data: { action: "UPDATE_SCRAPING_SOURCE", targetId: source.id, targetType: "ScrapingSource", adminId, details: `Updated source: ${source.name}` }
  });
  return source;
};

const deleteScrapingSource = async (id, adminId) => {
  const sourceToDelete = await prisma.scrapingSource.findUnique({ where: { id: id } });

  await prisma.scrapingSource.delete({ where: { id: id } });

  if (sourceToDelete) {
    await prisma.auditLog.create({
      data: { action: "DELETE_SCRAPING_SOURCE", targetId: id, targetType: "ScrapingSource", adminId, details: `Deleted source: ${sourceToDelete.name}` }
    });
  }
  return true;
};

module.exports = {
  calculateEngagement,
  getDashboard,
  refreshDashboard,
  getAdvancedAnalytics,
  listUsers,
  updateUserRole,
  banUser,
  unbanUser,
  getReports,
  reportArticle,
  resolveReport,
  getAuditLogs,
  getAiConfig,
  updateAiConfig,
  getTrendingTopics,
  incrementTopicHit,
  getAllOffers,
  createOffer,
  updateOffer,
  getScrapingSources,
  createScrapingSource,
  updateScrapingSource,
  deleteScrapingSource,
};
