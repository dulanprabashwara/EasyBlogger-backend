//@ts-nocheck
// src/jobs/wordpress.job.js
// In-memory scheduler for WordPress publish jobs — no database polling,
// each job fires exactly once at its scheduled time via setTimeout.

const prisma = require("../config/prisma");
const { pushArticleToWordPress, attemptDraftSave } = require("../services/wordpress.service");

// In-memory map of jobId → setTimeout handle, used to cancel or reschedule without a DB hit.
const _timeouts = new Map();

// ── INTERNAL HELPERS ─────────────────────────────────────────────────

// Marks a job as CANCELLED in the database with a reason string.
const _cancelJob = async (jobId, reason) => {
  try {
    await prisma.wordPressPublishJob.update({
      where: { id: jobId },
      data:  { status: "CANCELLED", errorMsg: reason },
    });
  } catch (err) {
    console.error(`[WordPress Scheduler] Failed to cancel job ${jobId}:`, err.message);
  }
};

// Validates article state, then attempts to publish to WordPress.
// Returns true when the job is fully resolved (published, failed, or cancelled).
// Returns false when the article is not yet PUBLISHED — caller can retry later.
const _runPublish = async (jobId, article, wpConnection) => {
  if (!article) {
    await _cancelJob(jobId, "Article no longer exists.");
    return true;
  }

  if (article.status === "DRAFT") {
    await _cancelJob(jobId, "Article is DRAFT and was never published on Easy Blogger. WordPress publish skipped.");
    return true;
  }

  if (article.status !== "PUBLISHED") {
    return false;
  }

  try {
    // Mark IN_PROGRESS to prevent another process from picking up the same job
    await prisma.wordPressPublishJob.update({ where: { id: jobId }, data: { status: "IN_PROGRESS" } });
  } catch {
    return true;
  }

  try {
    const { wpPostId, wpPostUrl } = await pushArticleToWordPress(article, wpConnection);
    await prisma.wordPressPublishJob.update({
      where: { id: jobId },
      data:  { status: "PUBLISHED", wpPostId, wpPostUrl, errorMsg: null, draftUrl: null },
    });
    console.log(`[WordPress Scheduler] ✅ Published "${article.title}" → ${wpPostUrl}`);
  } catch (publishErr) {
    // draftUrl is null when the draft save also fails — stored as null in the DB so the
    // frontend can distinguish "draft saved" from "both failed". The fallback dashboard
    // URL is used only for the log message, not persisted.
    const draftUrl    = await attemptDraftSave(article, wpConnection);
    const logDraftUrl = draftUrl
      || `https://wordpress.com/posts/${wpConnection?.siteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "") || ""}`;

    await prisma.wordPressPublishJob.update({
      where: { id: jobId },
      data:  { status: "FAILED", errorMsg: publishErr.message, draftUrl },
    });

    const suffix = logDraftUrl ? `. Draft/dashboard link: ${logDraftUrl}` : " and draft save also failed.";
    console.error(`[WordPress Scheduler] ❌ "${article.title}" failed: ${publishErr.message}${suffix}`);
  }

  return true;
};

// Fires when a job's timer elapses — fetches the job, runs publish, and retries once after 3 minutes if the article isn't PUBLISHED yet.
const _executeJob = async (jobId) => {
  _timeouts.delete(jobId);

  let job;
  try {
    job = await prisma.wordPressPublishJob.findUnique({
      where:   { id: jobId },
      include: { article: true, wpConnection: true },
    });
  } catch (err) {
    console.error(`[WordPress Scheduler] DB error fetching job ${jobId}:`, err.message);
    return;
  }

  if (!job)                     return console.warn(`[WordPress Scheduler] Job ${jobId} not found — skipped.`);
  if (job.status !== "PENDING") return console.log(`[WordPress Scheduler] Job ${jobId} is "${job.status}" — skipped.`);

  const handled = await _runPublish(jobId, job.article, job.wpConnection);

  if (!handled) {
    const retryKey = `${jobId}_retry`;
    if (_timeouts.has(retryKey)) {
      // Already retried once — cancel to prevent the job becoming an orphan
      _timeouts.delete(retryKey);
      await _cancelJob(
        jobId,
        `Article was not PUBLISHED 1 minute after scheduled time (status: "${job.article.status}"). Cancelled to prevent orphan content.`
      );
      console.warn(`[WordPress Scheduler] ⛔ Cancelled ${jobId} after retry.`);
    } else {
      console.log(`[WordPress Scheduler] Article not PUBLISHED yet — retrying in 1 minute.`);
      _timeouts.set(retryKey, setTimeout(() => _executeJob(jobId), 1 * 60 * 1000));
    }
  }
};

// ── PUBLIC API ────────────────────────────────────────────────────────

// Registers a setTimeout that fires the job at its scheduled time.
// Called when a job is created and again on server startup to restore pending jobs.
const registerJobTimeout = (jobId, scheduledAt) => {
  if (_timeouts.has(jobId)) {
    clearTimeout(_timeouts.get(jobId));
    _timeouts.delete(jobId);
  }

  const msUntilFire = new Date(scheduledAt).getTime() - Date.now();

  if (msUntilFire <= 0) {
    console.log(`[WordPress Scheduler] Job ${jobId} is overdue, firing now.`);
    setImmediate(() => _executeJob(jobId));
    return;
  }

  // Node.js setTimeout has a 32-bit ms limit (~24.8 days) — re-register for far-future jobs
  const MAX_MS = 24 * 24 * 60 * 60 * 1000;
  if (msUntilFire > MAX_MS) {
    _timeouts.set(jobId, setTimeout(() => registerJobTimeout(jobId, scheduledAt), MAX_MS));
    return;
  }

  _timeouts.set(jobId, setTimeout(() => _executeJob(jobId), msUntilFire));
  console.log(`[WordPress Scheduler] Job ${jobId} registered — fires at ${new Date(scheduledAt).toLocaleString()}.`);
};

// Clears the in-memory timer for a job without touching the database.
const cancelJobTimeout = (jobId) => {
  if (_timeouts.has(jobId)) {
    clearTimeout(_timeouts.get(jobId));
    _timeouts.delete(jobId);
  }
};

// Runs on server startup — re-registers timers for PENDING jobs and resets any IN_PROGRESS jobs that were interrupted.
const startWordPressJobs = async () => {
  let pendingJobs;
  try {
    pendingJobs = await prisma.wordPressPublishJob.findMany({
      where:  { status: { in: ["PENDING", "IN_PROGRESS"] } },
      select: { id: true, scheduledAt: true, status: true },
    });
  } catch (err) {
    console.error("[WordPress Scheduler] Failed to recover pending jobs:", err.message);
    return;
  }

  // Reset any jobs that were mid-execution when the server last shut down
  const interrupted = pendingJobs.filter((j) => j.status === "IN_PROGRESS");
  if (interrupted.length > 0) {
    await prisma.wordPressPublishJob.updateMany({
      where: { id: { in: interrupted.map((j) => j.id) } },
      data:  { status: "PENDING" },
    });
  }

  for (const job of pendingJobs) {
    registerJobTimeout(job.id, job.scheduledAt);
  }

  console.log(`[WordPress Scheduler] Ready — ${pendingJobs.length} job(s) recovered.`);
};

// Batch processor for tests — fetches all overdue PENDING jobs and runs them sequentially.
// Not used in production; the setTimeout scheduler handles individual jobs via _executeJob.
const processWordPressJobs = async () => {
  let pendingJobs;
  try {
    pendingJobs = await prisma.wordPressPublishJob.findMany({
      where:   { status: "PENDING", scheduledAt: { lte: new Date() } },
      include: { article: true, wpConnection: true },
    });
  } catch (err) {
    console.error("[WordPress Scheduler] Failed to fetch pending jobs:", err.message);
    return;
  }

  if (pendingJobs.length === 0) return;

  for (const job of pendingJobs) {
    const handled = await _runPublish(job.id, job.article, job.wpConnection);

    if (!handled) {
      const minutesPast = Math.floor((Date.now() - new Date(job.scheduledAt).getTime()) / 60000);
      if (minutesPast > 5) {
        await _cancelJob(
          job.id,
          `Article was not published on Easy Blogger within 5 minutes (status: "${job.article.status}"). WordPress publish cancelled.`
        );
      }
    }
  }
};

module.exports = { startWordPressJobs, registerJobTimeout, cancelJobTimeout, processWordPressJobs };