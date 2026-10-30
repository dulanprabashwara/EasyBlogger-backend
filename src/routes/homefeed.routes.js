//imports
const express = require("express");
const router  = express.Router();
const homefeedController = require("../controllers/homefeed.controller");
const { authenticate }   = require("../middlewares/auth");

router.use(authenticate); // check if user is logged in

// homefeed routes
router.get("/main",      homefeedController.getMainFeed);      // New feed
router.get("/following", homefeedController.getFollowingFeed); // Following feed
router.get("/personal",  homefeedController.getPersonalFeed);  // AI-powered personal feed

module.exports = router;