const admin = require("../config/firebase");
const prisma = require("../config/prisma");

//authenticate middleware to get jwt token from firebase and verify it to get the user raw
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No token provided.",
      });
    }

    const idToken = authHeader.split("Bearer ")[1];

    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    // Fetch the user from our database using the Firebase UID
    const user = await prisma.user.findUnique({
      where: { firebaseUid: decodedToken.uid },
      include: { bannedRecord: true },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found. Please register first.",
      });
    }

    // Check if user is banned
    if (user.bannedRecord) {
      const ban = user.bannedRecord;
      const isPermanent = !ban.bannedUntil;
      const isStillBanned =
        isPermanent || new Date() < new Date(ban.bannedUntil);

      //if ban send 403 respose to the frontend
      if (isStillBanned) {
        return res.status(403).json({
          success: false,
          message: "Your account has been suspended.",
          reason: ban.reason,
          bannedUntil: ban.bannedUntil,
        });
      }
    }

    if (user.role === "ADMIN" || user.role === "SUPER_ADMIN") {
      const userAgent = req.headers['user-agent'] || 'Unknown Device';
      let deviceName = "Desktop Browser";
      if (userAgent.includes("Windows")) deviceName = "Windows PC";
      else if (userAgent.includes("Mac")) deviceName = "Mac OS Device";
      else if (userAgent.includes("Android")) deviceName = "Android Mobile";
      else if (userAgent.includes("iPhone") || userAgent.includes("iPad")) deviceName = "Apple iOS Device";
      
      // Look for the most recent session for this specific device
      const deviceSession = await prisma.userSession.findFirst({
        where: { userId: user.id, deviceInfo: deviceName },
        orderBy: { lastActive: 'desc' }
      });

      if (deviceSession && deviceSession.status === "REVOKED") {
        // Firebase Tokens last an hour. We check if they logged in BEFORE the revoke happened.
        // auth_time is in seconds, JS needs milliseconds
        const tokenLoginTime = decodedToken.auth_time * 1000; 
        
        console.log(`[BOUNCER] Admin tried to access route on ${deviceName}. Status: REVOKED`);

        if (tokenLoginTime <= deviceSession.lastActive.getTime()) {
          console.log("[BOUNCER] Access Denied! Kicking user out to login screen.");
          return res.status(401).json({
            success: false,
            message: "Your session was remotely revoked. Please log in again."
          });
        } else {
          // If they successfully logged back in via Firebase, reactivate the session
          await prisma.userSession.update({
            where: { id: deviceSession.id },
            data: { status: "ACTIVE" }
          });
        }
      }
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Authentication/Database error:", error.message);

    // If the error comes from Firebase Auth verifyIdToken  if the token is invalid or expired
    if (
      error.code &&
      typeof error.code === "string" &&
      error.code.startsWith("auth/")
    ) {
      if (error.code === "auth/id-token-expired") {
        return res.status(401).json({
          success: false,
          message: "Token expired. Please log in again.",
        });
      }
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token.",
      });
    }

    // Otherwise, it is likely a Prisma database connection error or generic error
    return res.status(500).json({
      success: false,
      message:
        "An internal server/database error occurred during authentication.",
      error: error.message,
    });
  }
};

// authorize middleware to get the user raw that got the authneticate and check if the role is correct
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }
    if (req.user.role === "SUPER_ADMIN") {
      return next();
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action.",
      });
    }

    next();
  };
};

/**
 requirepremium middleware to get the user raw and check if the user is premium if not to block that route
 */
const requirePremium = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
  }

  if (!req.user.isPremium && !["ADMIN", "SUPER_ADMIN"].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "This feature requires a premium subscription.",
    });
  }

  next();
};

//optionalAuth middleware to allow a person who doesnt have a token to go to that route
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(); // No token — proceed as anonymous
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    const user = await prisma.user.findUnique({
      where: { firebaseUid: decodedToken.uid },
    });

    if (user) {
      req.user = user;
    }
  } catch {
    // Token invalid or expired — silently ignore and proceed as anonymous
  }
  next();
};

module.exports = { authenticate, authorize, requirePremium, optionalAuth };
