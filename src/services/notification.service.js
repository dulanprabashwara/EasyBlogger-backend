const prisma = require("../config/prisma");

const createNotification = async (app, { type, destUserId, sourceUserId, sourceArticleId }) => {
  console.log(`  Notification Triggered: Type=${type}, To=${destUserId}, From=${sourceUserId}, Article=${sourceArticleId}`);
  try {
    // Don't notify the user of their own actions
    if (destUserId === sourceUserId) return null;

    // Save to Database 
    const notification = await prisma.notification.create({
      data: { 
        type, 
        destUserId,
        sourceUserId,
        sourceArticleId,
      },
      include: {
        // Fetch the related data so the frontend can build the message
        sourceUser: { select: { username: true, displayName: true, avatarUrl: true } },
        sourceArticle: { select: { title: true, slug: true } }
      }
    });

    // Emit via Socket.io
    const io = app.get("io");
    if (io) {
      io.to(`user:${destUserId}`).emit("notification:receive", notification);
    }

    return notification;
  } catch (error) {
    console.error("Failed to save notification:", error.message);
    return null; 
  }
};

/**
 * Notify all followers when an author publishes a new article.
 */
const notifyFollowersOfNewArticle = async (app, authorId, articleId) => {
  console.log(`  Broadcasting new article (${articleId}) to followers of user (${authorId})`);
  
  try { 
    // get all users who are following this author
    const followers = await prisma.follow.findMany({
      where: { followingId: authorId },
      select: { followerId: true }
    });

    if (!followers || followers.length === 0) return 0; // No followers to notify

    //  Prepare the bulk insert payload
    const notificationPayloads = followers.map((follower) => ({
      type: "NEW_ARTICLE",
      destUserId: follower.followerId,
      sourceUserId: authorId,
      sourceArticleId: articleId
    }));

    //  Perform a bulk insert
    await prisma.notification.createMany({
      data: notificationPayloads,
      skipDuplicates: true
    });

    
    const authorDetails = await prisma.user.findUnique({
      where: { id: authorId },
      select: { username: true, displayName: true, avatarUrl: true }
    });
    
    const articleDetails = await prisma.article.findUnique({
      where: { id: articleId },
      select: { title: true, slug: true }
    });

    //  Emit  to all followers via Socket.io
    const io = app.get("io");
    if (io) {
      followers.forEach((follower) => {
        // Construct the payload to match what the frontend expects
        const socketPayload = {
          type: "NEW_ARTICLE",
          destUserId: follower.followerId,
          sourceUserId: authorId,
          sourceArticleId: articleId,
          createdAt: new Date(), // Approximate time for the UI
          isRead: false,
          sourceUser: authorDetails,
          sourceArticle: articleDetails
        };
        
        io.to(`user:${follower.followerId}`).emit("notification:receive", socketPayload);
      });
    }

    console.log(`Successfully notified ${followers.length} followers.`);
    return followers.length;

  } catch (error) {
    console.error("Failed to notify followers of new article:", error.message);
    return 0;
  }
};

const fetchUserNotifications = async (userId) => {
  return await prisma.notification.findMany({
    where: { destUserId: userId },
    orderBy: { createdAt: "desc" },
    
    include: {
      sourceUser: { select: { username: true, displayName: true, avatarUrl: true, } },
      sourceArticle: { select: { title: true, id: true } }
    }
  });
};

const deleteNotifications = async (userId, notificationId) => {
  // If a specific ID is provided, delete just that one. Otherwise, clear all.
  if (notificationId) {
    return await prisma.notification.deleteMany({
      where: { id: notificationId, destUserId: userId },
    });
  } else {
    return await prisma.notification.deleteMany({
      where: { destUserId: userId },
    });
  }
};

///
const publishNotification = async (app, { type, destUserId, sourceUserId, sourceArticleId }) => {
  console.log(`  Notification Triggered: Type=${type}, To=${destUserId}, From=${sourceUserId}, Article=${sourceArticleId}`);
  try {
    

    // 1. Save to Database  
    const notification = await prisma.notification.create({
      data: { 
        type, 
        destUserId,
        sourceUserId,
        sourceArticleId,
      },
      include: {
        // Fetch the related data so the frontend 
        sourceUser: { select: { username: true, displayName: true, avatarUrl: true } },
        sourceArticle: { select: { title: true, slug: true } }
      }
    });

    // 2. Emit instantly via Socket.io
    const io = app.get("io");
    if (io) {
      io.to(`user:${destUserId}`).emit("notification:receive", notification);
    }

    return notification;
  } catch (error) {
    console.error("Failed to save notification:", error.message);
    return null; 
  }
};

module.exports = { 
  createNotification, 
  notifyFollowersOfNewArticle, // <-- Export the new function
  fetchUserNotifications,
  deleteNotifications ,
  publishNotification
};