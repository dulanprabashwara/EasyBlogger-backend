const prisma = require("../config/prisma");
const { pushArticleToLinkedIn } = require("../services/linkedin.service");

// In-memory map of jobId → setTimeout handle.
const _timeouts = new Map();

// Marks a job CANCELLED in the database.
const _cancelJob = async (jobId, reason) => {
  try {
    await prisma.linkedInPublishJob.update({
      where: { id: jobId },
      data: { status: "CANCELLED", errorMsg: reason },
    });
  } catch (err) {
    console.error(`[LinkedIn Scheduler] Failed to cancel job ${jobId}:`, err.message);
  }
};

/**
 * Validates the article status, then pushes to LinkedIn.
 */
const _runPublish = async (jobId, article, liConnection, caption) => {
  if (!article) {
    await _cancelJob(jobId, "Article no longer exists.");
    return true;
  }

  if (article.status === "DRAFT") {
    await _cancelJob(jobId, "Article is DRAFT. LinkedIn publish skipped.");
    return true;
  }

  if (article.status !== "PUBLISHED") {
    return false; // Not ready yet, retry later
  }

  // Fetch latest job state to check for idempotency (Ghost Success recovery)
  const job = await prisma.linkedInPublishJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === "PUBLISHED" || job.status === "CANCELLED")
    return true;

  // If we already have a liPostId, it means a previous attempt succeeded on LinkedIn 
  // but failed to update our database. We just fix the database status and move on.
  if (job.liPostId) {
    console.log(`[LinkedIn Scheduler] Recovered Ghost Success for job ${jobId}. Marking as PUBLISHED.`);
    await prisma.linkedInPublishJob.update({
      where: { id: jobId },
      data: { status: "PUBLISHED", errorMsg: null },
    });
    return true;
  }

  try {
    await prisma.linkedInPublishJob.update({ where: { id: jobId }, data: { status: "IN_PROGRESS" } });
  } catch {
    return true; // Already handled by another process
  }

  try {
    const { liPostId, liPostUrl } = await pushArticleToLinkedIn(article, liConnection, caption, job);
    await prisma.linkedInPublishJob.update({
      where: { id: jobId },
      data: { status: "PUBLISHED", liPostId, liPostUrl, errorMsg: null },
    });
    console.log(`[LinkedIn Scheduler] ✅ Published "${article.title}" → ${liPostUrl}`);
  } catch (err) {
    // Check if the error was a network timeout/disconnect
    const isNetworkError = err.isNetworkError;

    const errorMsg = isNetworkError
      ? `Network/Timeout Error: Post state is UNKNOWN. It might have reached LinkedIn. (Original error: ${err.message})`
      : err.message;

    await prisma.linkedInPublishJob.update({
      where: { id: jobId },
      data: { status: "FAILED", errorMsg: errorMsg },
    });

    if (isNetworkError) {
      console.error(`[LinkedIn Scheduler] ⚠️ Unknown state for "${article.title}": Network issue occurred AFTER sending request.`);
    } else {
      console.error(`[LinkedIn Scheduler] ❌ "${article.title}" failed: ${err.message}`);
    }
  }

  return true;
};

/**
 * Fires when a scheduled job's timeout elapses.
 */
const _executeJob = async (jobId) => {
  _timeouts.delete(jobId);

  let job;
  try {
    job = await prisma.linkedInPublishJob.findUnique({
      where: { id: jobId },
      include: { article: true, liConnection: true },
    });
  } catch (err) {
    console.error(`[LinkedIn Scheduler] DB error fetching job ${jobId}:`, err.message);
    return;
  }

  if (!job)
    return console.warn(`[LinkedIn Scheduler] Job ${jobId} not found.`);
  if (job.status !== "PENDING")
    return;

  const handled = await _runPublish(jobId, job.article, job.liConnection, job.caption);

  if (!handled) {
    // Retry once after 1 minute
    const retryKey = `${jobId}_retry`;
    if (_timeouts.has(retryKey)) {
      _timeouts.delete(retryKey);
      await _cancelJob(jobId, "Article was not PUBLISHED 1 minute after scheduled time.");
    } else {
      console.log(`[LinkedIn Scheduler] Article not PUBLISHED yet — retrying in 1 minute.`);
      _timeouts.set(retryKey, setTimeout(() => _executeJob(jobId), 60 * 1000));
    }
  }
};

//Schedules a LinkedIn job
const registerLinkedInJob = (jobId, scheduledAt) => {
  if (_timeouts.has(jobId)) {
    clearTimeout(_timeouts.get(jobId));
    _timeouts.delete(jobId);
  }

  const msUntilFire = new Date(scheduledAt).getTime() - Date.now();

  if (msUntilFire <= 0) {
    setImmediate(() => _executeJob(jobId));
    return;
  }

  const MAX_MS = 24 * 60 * 60 * 1000;
  if (msUntilFire > MAX_MS) {
    _timeouts.set(jobId, setTimeout(() => registerLinkedInJob(jobId, scheduledAt), MAX_MS));
    return;
  }

  _timeouts.set(jobId, setTimeout(() => _executeJob(jobId), msUntilFire));
};

const cancelLinkedInJob = (jobId) => {
  if (_timeouts.has(jobId)) {
    clearTimeout(_timeouts.get(jobId));
    _timeouts.delete(jobId);
  }
};

//Recovers unfinished LinkedIn jobs from the database
const startLinkedInJobs = async () => {
  try {
    const pendingJobs = await prisma.linkedInPublishJob.findMany({
      where: { status: { in: ["PENDING", "IN_PROGRESS"] } },
      select: { id: true, scheduledAt: true, status: true },
    });

    const interrupted = pendingJobs.filter(j => j.status === "IN_PROGRESS");
    if (interrupted.length > 0) {
      await prisma.linkedInPublishJob.updateMany({
        where: { id: { in: interrupted.map(j => j.id) } },
        data: { status: "PENDING" },
      });
    }

    for (const job of pendingJobs) {
      registerLinkedInJob(job.id, job.scheduledAt);
    }

    console.log(`[LinkedIn Scheduler] Ready — ${pendingJobs.length} job(s) recovered.`);
  } catch (err) {
    console.error("[LinkedIn Scheduler] Failed to recover pending jobs:", err.message);
  }
};

module.exports = { startLinkedInJobs, registerLinkedInJob, cancelLinkedInJob };
