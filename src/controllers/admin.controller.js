// @ts-nocheck
const asyncHandler = require("../utils/asyncHandler");
const { sendSuccess, sendPaginated } = require("../utils/response");
const adminService = require("../services/admin.service");
const { parsePagination } = require("../utils/helpers");
const { excludedKeywords } = require('../config/excludedKeywords');
const prisma = require("../config/prisma");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

// ─── Dashboard ──────────────────────────────

const getDashboard = asyncHandler(async (req, res) => {
  const dashboard = await adminService.refreshDashboard();
  sendSuccess(res, { data: dashboard });
});

const getEngagementAnalytics = async (req, res, next) => {
  try {
    // Grab the '?days=' from the URL (default to 30 if not provided)
    const days = parseInt(req.query.days) || 30;

    // Call the service
    const chartData = await adminService.calculateEngagement(days);

    res.status(200).json({
      success: true,
      data: chartData
    });
  } catch (error) {
    next(error);
  }
};

const getAdminMetrics = async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const totalActions = await prisma.auditLog.count({
      where: {
        adminId: currentUserId
      }
    });

    const totalResolved = await prisma.auditLog.count({
      where: {
        adminId: currentUserId,
        action: {
          contains: 'RESOLVE',
          mode: 'insensitive'
        }
      }
    });

    // Send back just the two tiny numbers
    return res.status(200).json({
      success: true,
      data: { totalActions, totalResolved }
    });

  } catch (error) {
    console.error("Error fetching admin metrics:", error);
    return res.status(500).json({ success: false, message: "Failed to load metrics" });
  }
};

// ─── Users ──────────────────────────────────

const listUsers = asyncHandler(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { role, isPremium, search } = req.query;

  const { users, total } = await adminService.listUsers({
    page,
    limit,
    role,
    isPremium:
      isPremium === "true" ? true : isPremium === "false" ? false : undefined,
    search,
  });

  sendPaginated(res, { data: users, page, limit, total });
});

const updateUserRole = asyncHandler(async (/** @type {any} */ req, res) => {
  const user = await adminService.updateUserRole(
    req.user.id,
    req.params.userId,
    req.body.role,
  );
  sendSuccess(res, { message: "User role updated.", data: user });
});


const getPaginatedUsers = async (req, res) => {
  try {
    // Extract page and limit from the query string (default to page 1, 10 items)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const isPremium = req.query.premium; // 'true', 'false', or undefined
    const isBanned = req.query.banned;   // 'true', 'false', or undefined

    //Calculate how many records to skip
    const skip = (page - 1) * limit;

    const whereClause = {};

    if (search) {
      whereClause.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Handle Premium vs Regular
    if (isPremium === 'true') {
      whereClause.isPremium = true;
    } else if (isPremium === 'false') {
      whereClause.isPremium = false;
    }

    // Handle Banned vs Active
    if (isBanned === 'true') {
      whereClause.bannedRecord = { isNot: null };
    } else if (isBanned === 'false') {
      whereClause.bannedRecord = { is: null };
    }

    // Run both queries concurrently for maximum performance
    const [totalUsers, users] = await Promise.all([
      prisma.user.count({ where: whereClause }),
      prisma.user.findMany({
        where: whereClause,
        skip: skip,
        take: limit,
        orderBy: {
          createdAt: 'desc', // Shows newest users first
        },
        // Select only the fields you need for the list to keep the payload light
        select: {
          id: true,
          username: true,   
          displayName: true,
          email: true,
          role: true,
          createdAt: true,
          isPremium: true,   
          bannedRecord: true
        }
      })
    ]);

    //Calculate total pages
    const totalPages = Math.ceil(totalUsers / limit);

    // Send the structured response
    res.status(200).json({
      success: true,
      data: users,
      meta: {
        totalItems: totalUsers,
        currentPage: page,
        totalPages: totalPages,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error("Error fetching paginated users:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch users", 
      error: error.message 
    });
  }
};

// ─── Bans ───────────────────────────────────

const banUser = asyncHandler(async (/** @type {any} */ req, res) => {
  const { reason, bannedUntil } = req.body;
  const ban = await adminService.banUser(
    req.user.id,
    req.params.userId,
    reason,
    bannedUntil,
  );
  sendSuccess(res, { statusCode: 201, message: "User banned.", data: ban });
});

const unbanUser = asyncHandler(async (/** @type {any} */ req, res) => {
  await adminService.unbanUser(req.user.id, req.params.userId);
  sendSuccess(res, { message: "User unbanned." });
});

// ─── Reports ────────────────────────────────

const getReports = asyncHandler(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { status } = req.query;
  const { reports, total } = await adminService.getReports({
    page,
    limit,
    status,
  });
  sendPaginated(res, { data: reports, page, limit, total });
});

const reportArticle = asyncHandler(async (/** @type {any} */ req, res) => {
  const { reason, details } = req.body;
  const report = await adminService.reportArticle(
    req.user.id,
    req.params.articleId,
    reason,
    details,
  );
  sendSuccess(res, {
    statusCode: 201,
    message: "Article reported.",
    data: report,
  });
});

const resolveReport = asyncHandler(async (/** @type {any} */ req, res) => {
  const report = await adminService.resolveReport(
    req.user.id,
    req.params.reportId,
    req.body.status,
  );
  sendSuccess(res, { message: "Report resolved.", data: report });
});

// ─── Audit Logs ─────────────────────────────
const getPaginatedAuditLogs = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    //Build the dynamic where clause based on filters provided
    const whereClause = {};

    // Filter by Action (Case-insensitive search)
    if (req.query.action && req.query.action !== 'All Actions' && req.query.action !== '') {
      const dbActionFormat = req.query.action.replace(/ /g, '_').toUpperCase();

      whereClause.action = {
        equals: dbActionFormat
      };
    }

    // Filter by Admin Name (Searches both username and displayName)
    if (req.query.admin && req.query.admin !== 'All Admins' && req.query.admin !== '') {
      whereClause.admin = {
        OR: [
          { displayName: { contains: req.query.admin, mode: 'insensitive' } },
          { username: { contains: req.query.admin, mode: 'insensitive' } }
        ]
      };
    }

    // Filter by Date Range
    if (req.query.startDate || req.query.endDate) {
      whereClause.createdAt = {};
      if (req.query.startDate) {
        whereClause.createdAt.gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        // Append time to include the entire end date
        whereClause.createdAt.lte = new Date(`${req.query.endDate}T23:59:59.999Z`);
      }
    }

    //Pass the whereClause to BOTH count() and findMany()
    const [totalLogs, logs] = await Promise.all([
      prisma.auditLog.count({
        where: whereClause
      }),
      prisma.auditLog.findMany({
        where: whereClause,
        skip: skip,
        take: limit,
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          id: true,
          action: true,
          targetId: true,
          targetType: true,
          details: true,
          ipAddress: true,
          createdAt: true,
          admin: {
            select: {
              username: true,
              displayName: true
            }
          }
        }
      })
    ]);

    const totalPages = Math.ceil(totalLogs / limit);

    res.status(200).json({
      success: true,
      data: logs,
      meta: {
        totalItems: totalLogs,
        currentPage: page,
        totalPages: totalPages,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error("Error fetching paginated audit logs:", error);
    res.status(500).json({ success: false, message: "Failed to fetch audit logs", error: error.message });
  }
};

const getAuditLogFilters = async (req, res) => {
  try {
    // Get unique actions
    const uniqueActions = await prisma.auditLog.findMany({
      distinct: ['action'],
      select: { action: true }
    });

    // Get unique admins
    const uniqueAdmins = await prisma.auditLog.findMany({
      distinct: ['adminId'],
      select: {
        admin: {
          select: { username: true, displayName: true }
        }
      }
    });

    // Format for the frontend
    const actionList = uniqueActions.map(a => 
      a.action.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase())
    );
    
    const adminList = uniqueAdmins
      .filter(a => a.admin) // Safety check in case an admin was deleted
      .map(a => a.admin.displayName || a.admin.username);

    res.status(200).json({
      success: true,
      data: { 
        actions: [...new Set(actionList)], 
        admins: [...new Set(adminList)] 
      }
    });

  } catch (error) {
    console.error("Error fetching audit log filters:", error);
    res.status(500).json({ success: false, message: "Failed to fetch filters" });
  }
};

const getAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { adminId, action } = req.query;
  const { logs, total } = await adminService.getAuditLogs({
    page,
    limit,
    adminId,
    action,
  });
  sendPaginated(res, { data: logs, page, limit, total });
});

// ─── AI Config ──────────────────────────────

const getAiConfig = asyncHandler(async (req, res) => {
  const config = await adminService.getAiConfig();
  sendSuccess(res, { data: config });
});

const updateAiConfig = asyncHandler(async (/** @type {any} */ req, res) => {
  const config = await adminService.updateAiConfig(req.user.id, req.body);
  sendSuccess(res, { message: "AI config updated.", data: config });
});

// ─── Trending ───────────────────────────────

const getTrendingTopics = asyncHandler(async (/** @type {any} */ req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const topics = await adminService.getTrendingTopics(limit);
  sendSuccess(res, { data: topics });
});

// ─── Offers ───────────────────────────────
const getOffers = asyncHandler(async (/** @type {any} */ req, res, next) => {
  try {
    // Assuming adminService is already imported at the top of this file
    const offers = await adminService.getAllOffers();
    res.status(200).json({ success: true, data: offers });
  } catch (error) {
    next(error); // Passes the error to your teammate's error handler
  }
});

const createOffer = asyncHandler(async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const newOffer = await adminService.createOffer(req.body, adminId);
    res.status(201).json({ success: true, data: newOffer });
  } catch (error) {
    next(error);
  }
});

const updateOffer = asyncHandler(async (req, res, next) => {
  try {
    const { id } = req.params; // Grabs the ID from the URL
    const adminId = req.user.id;
    const updatedOffer = await adminService.updateOffer(id, req.body, adminId);
    res.status(200).json({ success: true, data: updatedOffer });
  } catch (error) {
    next(error);
  }
});

// ─── scraping sources ───────────────────────────────
const getPaginatedScrapingSources = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build the dynamic where clause
    const whereClause = {};

    //Listen for the Category dropdown
    if (req.query.category && req.query.category !== 'All Categories') {
      whereClause.category = req.query.category;
    }

    // Listen for a text search if ever add a search bar
    if (req.query.search) {
      whereClause.OR = [
        { name: { contains: req.query.search, mode: 'insensitive' } },
        { url: { contains: req.query.search, mode: 'insensitive' } }
      ];
    }

    // Run count and fetch concurrently
    const [totalSources, sources] = await Promise.all([
      prisma.scrapingSource.count({
        where: whereClause
      }),
      prisma.scrapingSource.findMany({
        where: whereClause,
        skip: skip,
        take: limit,
        orderBy: [
          { createdAt: 'desc' },
          { id: 'asc' }
        ]
      })
    ]);

    const totalPages = Math.ceil(totalSources / limit);

    res.status(200).json({
      success: true,
      data: sources,
      meta: {
        totalItems: totalSources,
        currentPage: page,
        totalPages: totalPages,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error("Error fetching paginated scraping sources:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch scraping sources", 
      error: error.message 
    });
  }
};

const getScrapingSources = asyncHandler(async (req, res, next) => {
  try {
    const sources = await adminService.getScrapingSources();
    res.status(200).json({ success: true, data: sources });
  } catch (error) {
    next(error);
  }
});

const createScrapingSource = asyncHandler(async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const newSource = await adminService.createScrapingSource(req.body, adminId);
    res.status(201).json({ success: true, data: newSource });
  } catch (error) {
    next(error);
  }
});

const updateScrapingSource = asyncHandler(async (req, res, next) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const updatedSource = await adminService.updateScrapingSource(id, req.body, adminId);
    res.status(200).json({ success: true, data: updatedSource });
  } catch (error) {
    next(error);
  }
});

const deleteScrapingSource = asyncHandler(async (req, res, next) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    await adminService.deleteScrapingSource(id, adminId);
    res.status(200).json({ success: true, message: "Source deleted successfully" });
  } catch (error) {
    next(error);
  }
});

const getDefaultKeywords = asyncHandler(async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: excludedKeywords });
  } catch (error) {
    next(error);
  }
});

//  ─── URL validation ───────────────────────────────
const validateUrl = asyncHandler(async (req, res, next) => {
  try {
    const { url } = req.body;

    // Ensure it has https:// so the fetch doesn't crash
    const formattedUrl = url.startsWith('http') ? url : `https://${url}`;

    // Ping the website- Pretending to be a normal web browser
    const response = await fetch(formattedUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    // If the website returns a 200 OK status, it is real and scrapable!
    if (response.ok) {
      return res.status(200).json({ success: true, data: { valid: true } });
    } else {
      // It exists, but it blocked us or returned a 404
      return res.status(200).json({ success: true, data: { valid: false } });
    }
  } catch (error) {
    // The domain doesn't exist at all, or the site is completely down
    return res.status(200).json({ success: true, data: { valid: false } });
  }
});

// ─── Profile & Sessions ──────────────────────────────

const updateAdminProfile = asyncHandler(async (req, res) => {
  const { displayName, bio, avatarUrl,receiveWeeklyExport} = req.body;
  const adminId = req.user.id;

  const updatedAdmin = await prisma.user.update({
    where: { id: adminId },
    data: {
      displayName: displayName,
      bio: bio,
      avatarUrl: avatarUrl,
      receiveWeeklyExport: receiveWeeklyExport
    }
  });

  await prisma.auditLog.create({
    data: {
      adminId: adminId,
      action: "UPDATE_PROFILE",
      targetId: adminId,
      targetType: "User",
      details: "Admin updated their profile details."
    }
  });

  sendSuccess(res, { message: "Profile updated successfully", data: updatedAdmin });
});

const registerSession = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const userAgent = req.headers['user-agent'] || 'Unknown Device';
  const ipAddress = req.ip || req.connection.remoteAddress || 'Unknown IP';

  let deviceName = "Desktop Browser";
  if (userAgent.includes("Windows")) deviceName = "Windows PC";
  else if (userAgent.includes("Mac")) deviceName = "Mac OS Device";
  else if (userAgent.includes("Android")) deviceName = "Android Mobile";
  else if (userAgent.includes("iPhone") || userAgent.includes("iPad")) deviceName = "Apple iOS Device";

  // Check if this exact device/IP is already registered and active to avoid spamming the DB
  let session = await prisma.userSession.findFirst({
    where: { userId: adminId, ipAddress: ipAddress, status: "ACTIVE" }
  });

  // If not, create a real session in Postgres!
  if (!session) {
    session = await prisma.userSession.create({
      data: {
        userId: adminId,
        deviceInfo: deviceName,
        ipAddress: ipAddress,
        status: "ACTIVE"
      }
    });
  }else {
    session = await prisma.userSession.update({
      where: { id: session.id },
      data: { 
        lastActive: new Date(),
        deviceInfo: deviceName //updates info in case they switched from mobile to desktop on the same IP
      }
    });
  }

  sendSuccess(res, { data: session });
});

const getActiveSessions = asyncHandler(async (req, res) => {
  const sessions = await prisma.userSession.findMany({
    where: { userId: req.user.id, status: "ACTIVE" },
    orderBy: { lastActive: "desc" }
  });
  
  sendSuccess(res, { data: sessions });
});

const revokeSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const adminId = req.user.id;

  await prisma.userSession.update({
    where: { id: sessionId },
    data: { status: "REVOKED"
          }
  });

  await prisma.auditLog.create({
    data: {
      adminId: adminId,
      action: "REVOKE_SESSION",
      targetId: sessionId,
      targetType: "UserSession",
      details: "Admin revoked a device session."
    }
  });

  sendSuccess(res, { message: "Session revoked successfully" });
});

// ─── Support tickets ──────────────────────────────

// Fetch support requests with pagination and optional status filter
const getPaginatedSupportRequests = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    let whereClause = {};
    
    //Build dynamic filters based on the selected UI tab
    if (req.query.status === 'PENDING') {
      // Show ALL pending tickets, regardless of age
      whereClause.status = 'PENDING';
      
    } else if (req.query.status === 'RESOLVED') {
      // Show ONLY resolved tickets updated within the last 7 days
      whereClause.status = 'RESOLVED';
      whereClause.updatedAt = { gte: sevenDaysAgo }; 
      
    } else {
      // 'ALL' Filter: Show ALL pending tickets OR recent resolved tickets
      whereClause.OR = [
        { status: 'PENDING' },
        { 
          status: 'RESOLVED',
          updatedAt: { gte: sevenDaysAgo }
        }
      ];
    }

    const [totalRequests, requests] = await Promise.all([
      prisma.supportRequest.count({
        where: whereClause
      }),
      prisma.supportRequest.findMany({
        where: whereClause,
        skip: skip,
        take: limit,
        orderBy: [
          { createdAt: 'desc' }, // Newest tickets at the top
          { id: 'asc' }
        ]
      })
    ]);

    const totalPages = Math.ceil(totalRequests / limit);

    res.status(200).json({
      success: true,
      data: requests,
      meta: {
        totalItems: totalRequests,
        currentPage: page,
        totalPages: totalPages,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error("Error fetching support requests:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch support requests", 
      error: error.message 
    });
  }
};

// Update a ticket (e.g., mark as read, or mark as resolved)
const updateSupportRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, isRead } = req.body;

    // Build update data dynamically based on what the frontend sends
    const updateData = {};
    if (status) updateData.status = status;
    if (typeof isRead === 'boolean') updateData.isRead = isRead;

    const updatedRequest = await prisma.supportRequest.update({
      where: { id: id },
      data: updateData
    });

    res.status(200).json({ 
      success: true, 
      data: updatedRequest 
    });

  } catch (error) {
    console.error("Error updating support request:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to update support request", 
      error: error.message 
    });
  }
};

//Dashboard Analytics
const getDashboardFeeds = async (req, res) => {
  try {
    //Fetch the 5 most recent articles
    const recentArticles = await prisma.article.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        author: { 
          select: { 
            displayName: true, 
            email: true,
            avatarUrl: true 
          } 
        }
      }
    });

    //Fetch the 10 most recent platform events
    const recentActivity = await prisma.platformEvent.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' }
    });

    res.status(200).json({
      success: true,
      data: {
        recentArticles,
        recentActivity
      }
    });

  } catch (error) {
    console.error("Error fetching dashboard feeds:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch dashboard feeds",
      error: error.message 
    });
  }
};

const getAnalyticsCharts = asyncHandler(async (req, res) => {
  const chartData = await adminService.getAdvancedAnalytics();
  
  sendSuccess(res, { 
    data: chartData 
  });
});

const inviteAdmin = async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    // Check if the user is ALREADY registered and is an admin
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser && existingUser.role !== "USER") {
      return res.status(400).json({ success: false, message: "User is already an Admin." });
    }

    // Generate required fields for your schema
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

    // Save the invitation to your existing table
    await prisma.adminInvitation.upsert({
      where: { email },
      update: {
        token: inviteToken,
        expiresAt: expiresAt,
        status: "PENDING" // Reset to pending if we are resending the invite
      },
      create: { 
        email,
        token: inviteToken,
        expiresAt: expiresAt
      },
    });

    //Configure email transporter
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    //Create the email content 
    // (We can optionally append the token to the URL if you ever want to build a custom welcome page later)
    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`; 
    
    const mailOptions = {
      from: `"Easy Blogger Admin" <${process.env.SMTP_USER}>`, 
      to: email, 
      subject: "Invitation to Join Easy Blogger Admin Panel",
      html: `
        <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #E5E7EB; border-radius: 10px;">
          <h2 style="color: #111827;">You've been invited!</h2>
          <p style="color: #374151; font-family: sans-serif; line-height: 1.6;">
            You have been invited to join the <strong>Easy Blogger</strong> platform as an Administrator.
          </p>
          <p style="color: #374151; font-family: sans-serif; line-height: 1.6;">
            To accept this invitation, simply log in or create an account using this email address. Your account will automatically be upgraded to Admin status.
          </p>
          <p style="color: #374151; font-family: sans-serif; line-height: 1.6;">
            <em>Note: This invitation will expire in 7 days.</em>
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${loginUrl}" style="background-color: #1ABC9C; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-family: sans-serif; display: inline-block;">
              Log In / Sign Up
            </a>
          </div>
        </div>
      `,
    };

    //Send the email
    await transporter.sendMail(mailOptions);

    return res.status(200).json({ 
      success: true, 
      message: `Invitation successfully sent and recorded for ${email}` 
    });
    
  } catch (error) {
    console.error("Failed to send admin invitation:", error);
    return res.status(500).json({ success: false, message: "Failed to process invitation." });
  }
};

module.exports = {
  getDashboard,
  getEngagementAnalytics,
  listUsers,
  updateUserRole,
  getPaginatedUsers,
  banUser,
  unbanUser,
  getReports,
  reportArticle,
  resolveReport,
  getPaginatedAuditLogs,
  getAuditLogFilters,
  getAuditLogs,
  getAiConfig,
  updateAiConfig,
  getTrendingTopics,
  getOffers,
  createOffer,
  updateOffer,
  getPaginatedScrapingSources,
  getScrapingSources,
  createScrapingSource,
  validateUrl,
  updateScrapingSource,
  deleteScrapingSource,
  getDefaultKeywords,
  getAdminMetrics,
  updateAdminProfile,
  revokeSession,
  registerSession,
  getActiveSessions,
  updateSupportRequest,
  getPaginatedSupportRequests,
  getDashboardFeeds,
  getAnalyticsCharts,
  inviteAdmin,
};
