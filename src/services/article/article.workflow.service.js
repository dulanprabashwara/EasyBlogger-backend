/* src/services/article/article.workflow.service.js */

const prisma = require("../../config/prisma");
const ApiError = require("../../utils/ApiError");
const { generateUniqueSlug, calculateReadingTime } = require("../../utils/helpers");
const {
  ARTICLE_STATUS,
  ARTICLE_AUTHOR_INCLUDE,
} = require("./article.constants");
const {
  getOwnedArticleOrThrow,
  requireCompleteArticle,
  normalizeTags,
  parseScheduledAt,
  buildClearedEditingBackupData,
  incrementPublishedArticleCount,
  buildEditExistingPayload,
  applyEditExistingTimestamp,
  buildEditAsNewPayload,
  shouldUpdateArticleTimestamp,
} = require("./article.helpers");

const { notifyFollowersOfNewArticle,publishNotification} = require("../notification.service");
const {generateSummary}= require ("../articleSummary.service");
/*
 Publishes or schedules an article.
 */
async function publishArticle(app, articleId, userId, payload) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  if (article.status === ARTICLE_STATUS.PUBLISHED) {
    throw ApiError.badRequest("This article is already published.");
  }

  requireCompleteArticle(
    {
      title: article.title,
      content: article.content,
    },
    ARTICLE_STATUS.PUBLISHED,
  );

  const tags = normalizeTags(payload.tags);
  // Determine if we are publishing immediately or scheduling for later.
  // This helps keep the 'timing' logic flexible for the frontend.
  const timing = String(payload.timing || "now").trim().toLowerCase();

  if (timing !== "now" && timing !== "schedule") {
    throw ApiError.badRequest("timing must be either 'now' or 'schedule'.");
  }

  const updateData = {
    tags,
  };

  if (timing === "schedule") {
    updateData.status = ARTICLE_STATUS.SCHEDULED;
    updateData.scheduledAt = parseScheduledAt(payload.scheduledAt);
    updateData.publishedAt = null;
  } else {
    updateData.status = ARTICLE_STATUS.PUBLISHED;
    updateData.publishedAt = new Date();
    updateData.scheduledAt = null;

    // We clear backups because once published, the "editing session" is complete.
    Object.assign(updateData, buildClearedEditingBackupData());
  }

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: updateData,
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  if (
    article.status !== ARTICLE_STATUS.PUBLISHED &&
    updatedArticle.status === ARTICLE_STATUS.PUBLISHED
  ) {
    await incrementPublishedArticleCount(userId);
}
generateSummary (updatedArticle.id,userId).catch(console.error);

//only if the articl eis a published one
if (updatedArticle.status === ARTICLE_STATUS.PUBLISHED)
{
   await publishNotification(app, {
    type: "NEW_ARTICLE",
    destUserId: userId, 
    sourceUserId: userId,    
    sourceArticleId: updatedArticle.id   
  });
await notifyFollowersOfNewArticle(app, userId, updatedArticle.id).catch(console.error);

}

  return updatedArticle;
}

/*
 Starts an "Edit Existing" session with backup.
 */
async function startExistingArticleEditing(articleId, userId) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  if (article.status === ARTICLE_STATUS.PUBLISHED) {
    throw ApiError.badRequest(
      "Published articles cannot be edited from this page.",
    );
  }

  // Backup is created when starting a fresh session from a DRAFT or SCHEDULED article.
  // This ensures we always have the "original" state to restore to.
  const shouldCreateBackup =
    (article.status === ARTICLE_STATUS.DRAFT ||
      article.status === ARTICLE_STATUS.SCHEDULED) &&
    !article.editingStartedAt;

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: {
      status: ARTICLE_STATUS.EDITING,
      ...(shouldCreateBackup
        ? {
          editingBackupTitle: article.title,
          editingBackupContent: article.content,
          editingBackupCoverImage: article.coverImage,
          editingStartedAt: article.updatedAt,
        }
        : {}),
    },
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  return updatedArticle;
}

/*
 Saves article for preview in "Edit Existing" flow.
 */
async function saveExistingArticleForPreview(articleId, userId, payload) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  const nextTitle = payload.title?.trim() || "";
  const nextContent = payload.content || "";

  requireCompleteArticle(
    {
      title: nextTitle,
      content: nextContent,
    },
    ARTICLE_STATUS.DRAFT,
  );

  const updateData = {
    ...buildEditExistingPayload(payload),
    status: ARTICLE_STATUS.DRAFT,
  };

  if (nextTitle && nextTitle !== article.title) {
    updateData.slug = await generateUniqueSlug(nextTitle);
  }

  applyEditExistingTimestamp(article, updateData);

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: updateData,
    include: ARTICLE_AUTHOR_INCLUDE,
  });
  return updatedArticle;
}

/*
 Autosave for "Edit Existing" flow.
 */
async function autosaveExistingArticle(articleId, userId, payload) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  const updateData = {
    ...buildEditExistingPayload(payload),
    status: ARTICLE_STATUS.EDITING,
  };

  if (
    payload.title &&
    payload.title.trim() &&
    payload.title.trim() !== article.title
  ) {
    updateData.slug = await generateUniqueSlug(payload.title.trim());
  }

  if (shouldUpdateArticleTimestamp(article, updateData)) {
    applyEditExistingTimestamp(article, updateData);
  }

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: updateData,
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  return updatedArticle;
}

/*
 Discards changes and restores from backup in "Edit Existing" flow.
 */
async function discardExistingArticleEdits(articleId, userId) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  if (!article.editingStartedAt) {
    return article;
  }

  // If the article is scheduled (has scheduledAt), restore its status to SCHEDULED
  // so it remains in the scheduled queue and will publish automatically.
  const isScheduledArticle = Boolean(article.scheduledAt);
  const targetStatus = isScheduledArticle
    ? ARTICLE_STATUS.SCHEDULED
    : ARTICLE_STATUS.DRAFT;

  // Restore the article and reset its timestamp to the point before editing began.
  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: {
      title: article.editingBackupTitle ?? article.title,
      content: article.editingBackupContent ?? article.content,
      coverImage: article.editingBackupCoverImage ?? article.coverImage,
      readingTime: calculateReadingTime(
        article.editingBackupContent || article.content || "",
      ),
      status: targetStatus,
      updatedAt: article.editingStartedAt || article.updatedAt,
      ...buildClearedEditingBackupData(),
    },
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  return updatedArticle;
}

/*
 Finalizes "Edit Existing" session and saves as draft.
 */
async function saveExistingArticleAsDraft(articleId, userId, payload) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  const nextTitle = payload.title?.trim() || "";
  const nextContent = payload.content || "";

  requireCompleteArticle(
    {
      title: nextTitle,
      content: nextContent,
    },
    ARTICLE_STATUS.DRAFT,
  );

  const updateData = {
    ...buildEditExistingPayload(payload),
    status: ARTICLE_STATUS.DRAFT,
    ...buildClearedEditingBackupData(),
  };

  if (nextTitle && nextTitle !== article.title) {
    updateData.slug = await generateUniqueSlug(nextTitle);
  }

  applyEditExistingTimestamp(article, updateData);

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: updateData,
    include: ARTICLE_AUTHOR_INCLUDE,
  });
  return updatedArticle;
}

/*
 Clears backup metadata without affecting timestamp.
 */
async function clearEditExistingBackup(articleId, userId) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: {
      ...buildClearedEditingBackupData(),
      updatedAt: article.updatedAt,
    },
  });

  return updatedArticle;
}

/*
 Starts an "Edit As New" session (cloning).
 */
async function startEditAsNewArticle(sourceArticleId, userId) {
  const sourceArticle = await getOwnedArticleOrThrow(sourceArticleId, userId);

  if (sourceArticle.status === ARTICLE_STATUS.PUBLISHED) {
    throw ApiError.badRequest(
      "Published articles cannot be edited as new from this page.",
    );
  }

  // Using a transaction ensures that we don't end up with partial 
  // data or multiple orphaned clones if the request fails halfway.
  // We explicitly set a higher timeout (15s) and pass the 'tx' client to helpers.
  // This prevents connection pool contention and 'Transaction not found' errors 
  // that occur on slower networks or busy databases when using the default 5s timeout.
  const result = await prisma.$transaction(async (tx) => {
    const existingCopies = await tx.article.findMany({
      where: {
        authorId: userId,
        status: ARTICLE_STATUS.EDITING,
        isEditAsNew: true,
        sourceArticleId,
      },
      // We prioritize the most recently modified copy to let the user pick up where they left off.
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      include: ARTICLE_AUTHOR_INCLUDE,
    });

    // Cleanup logic: If multiple editing copies exist for some reason, 
    // delete duplicates and return the most recent one.
    if (existingCopies.length > 0) {
      const [primaryCopy, ...duplicateCopies] = existingCopies;

      if (duplicateCopies.length > 0) {
        await tx.article.deleteMany({
          where: {
            id: {
              in: duplicateCopies.map((article) => article.id),
            },
          },
        });
      }

      return primaryCopy;
    }

    // We MUST pass 'tx' here to reuse the current transaction's database connection.
    // Calling generateUniqueSlug with the global prisma client inside a transaction 
    // can exhaust the connection pool and cause the transaction to time out.
    const slug = await generateUniqueSlug(
      sourceArticle.title?.trim() || "Untitled",
      tx,
    );

    return tx.article.create({
      data: {
        title: sourceArticle.title,
        slug,
        content: "",
        summary: null,
        coverImage: null,
        tags: [],
        readingTime: 0,
        status: ARTICLE_STATUS.EDITING,
        isAiGenerated: Boolean(sourceArticle.isAiGenerated),
        isEditAsNew: true,
        sourceArticleId: sourceArticle.id,
        authorId: userId,
      },
      include: ARTICLE_AUTHOR_INCLUDE,
    });
  }, {
    // 15s provides ample headroom for slug generation and DB writes on high-latency connections
    maxWait: 15000,
    timeout: 15000,
  });

  return result;
}

/*
 Autosave for "Edit As New" flow.
 */
async function autosaveEditAsNewArticle(articleId, userId, payload) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  if (!article.isEditAsNew) {
    throw ApiError.badRequest("This article is not an edit-as-new article.");
  }

  const updateData = {
    ...buildEditAsNewPayload(article, payload),
    status: ARTICLE_STATUS.EDITING,
  };

  if (shouldUpdateArticleTimestamp(article, updateData)) {
    updateData.updatedAt = new Date();
  }

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: updateData,
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  return updatedArticle;
}

/*
 Discards an "Edit As New" article.
 */
async function discardEditAsNewArticle(articleId, userId) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  if (!article.isEditAsNew) {
    throw ApiError.badRequest("This article is not an edit-as-new article.");
  }

  await prisma.article.delete({
    where: { id: articleId },
  });

  return { deleted: true };
}

/*
 Finalizes "Edit As New" session and saves as draft.
 */
async function saveEditAsNewArticleAsDraft(articleId, userId, payload) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  if (!article.isEditAsNew) {
    throw ApiError.badRequest("This article is not an edit-as-new article.");
  }

  const nextContent = payload.content || "";

  requireCompleteArticle(
    {
      title: article.title,
      content: nextContent,
    },
    ARTICLE_STATUS.DRAFT,
  );

  const updateData = {
    ...buildEditAsNewPayload(article, payload),
    status: ARTICLE_STATUS.DRAFT,
    isEditAsNew: true,
  };

  if (shouldUpdateArticleTimestamp(article, updateData)) {
    updateData.updatedAt = new Date();
  }

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: updateData,
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  return updatedArticle;
}

/*
 Starts editing a published article (creates backup and sets status to EDITING_PUBLISHED).
 Only owned articles can be edited.
 */
async function startPublishedArticleEditing(articleId, userId) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  const isPublishedState =
    article.status === ARTICLE_STATUS.PUBLISHED ||
    article.status === ARTICLE_STATUS.REPUBLISHED ||
    article.status === ARTICLE_STATUS.EDITING_PUBLISHED;

  if (!isPublishedState) {
    throw ApiError.badRequest("Only published articles can be edited here.");
  }

  const shouldCreateBackup = !article.editingStartedAt;

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: {
      status: ARTICLE_STATUS.EDITING_PUBLISHED,
      ...(shouldCreateBackup
        ? {
            editingBackupTitle: article.title,
            editingBackupContent: article.content,
            editingBackupCoverImage: article.coverImage,
            editingStartedAt: article.updatedAt,
          }
        : {}),
    },
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  return updatedArticle;
}

/*
 Autosave for published article editing.
 */
async function autosavePublishedArticle(articleId, userId, payload) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  const updateData = {
    ...buildEditExistingPayload(payload),
    status: ARTICLE_STATUS.EDITING_PUBLISHED,
  };

  if (
    payload.title &&
    payload.title.trim() &&
    payload.title.trim() !== article.title
  ) {
    updateData.slug = await generateUniqueSlug(payload.title.trim());
  }

  if (shouldUpdateArticleTimestamp(article, updateData)) {
    updateData.updatedAt = new Date();
  }

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: updateData,
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  return updatedArticle;
}

/*
 Save published article for preview page.
 */
async function savePublishedArticleForPreview(articleId, userId, payload) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  const nextTitle = payload.title?.trim() || article.title;
  const nextContent = payload.content || article.content;

  requireCompleteArticle(
    { title: nextTitle, content: nextContent },
    ARTICLE_STATUS.EDITING_PUBLISHED
  );

  const updateData = {
    ...buildEditExistingPayload(payload),
    status: ARTICLE_STATUS.EDITING_PUBLISHED,
  };

  if (nextTitle && nextTitle !== article.title) {
    updateData.slug = await generateUniqueSlug(nextTitle);
  }

  updateData.updatedAt = new Date();

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: updateData,
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  return updatedArticle;
}

/*
 Republish edited published article (sets status to REPUBLISHED and clears backup).
 */
async function republishArticle(articleId, userId, payload = {}) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  const nextTitle = payload.title?.trim() || article.title;
  const nextContent = payload.content || article.content;

  requireCompleteArticle(
    { title: nextTitle, content: nextContent },
    ARTICLE_STATUS.REPUBLISHED
  );

  const updateData = {
    ...buildEditExistingPayload({
      title: nextTitle,
      content: nextContent,
      coverImage: payload.coverImage !== undefined ? payload.coverImage : article.coverImage,
    }),
    status: ARTICLE_STATUS.REPUBLISHED,
    isEdited: true,
    updatedAt: new Date(),
    ...buildClearedEditingBackupData(),
  };

  if (nextTitle && nextTitle !== article.title) {
    updateData.slug = await generateUniqueSlug(nextTitle);
  }

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: updateData,
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  generateSummary(updatedArticle.id, userId).catch(console.error);

  return updatedArticle;
}

/*
 Discards changes and restores published article to its pre-edit state.
 */
async function discardPublishedArticleEdits(articleId, userId) {
  const article = await getOwnedArticleOrThrow(articleId, userId);

  if (!article.editingStartedAt) {
    const resetStatus = await prisma.article.update({
      where: { id: articleId },
      data: {
        status: ARTICLE_STATUS.PUBLISHED,
      },
      include: ARTICLE_AUTHOR_INCLUDE,
    });
    return resetStatus;
  }

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: {
      title: article.editingBackupTitle || article.title,
      content: article.editingBackupContent || article.content,
      coverImage: article.editingBackupCoverImage,
      readingTime: calculateReadingTime(article.editingBackupContent || ""),
      status: ARTICLE_STATUS.PUBLISHED,
      updatedAt: article.editingStartedAt,
      ...buildClearedEditingBackupData(),
    },
    include: ARTICLE_AUTHOR_INCLUDE,
  });

  return updatedArticle;
}

module.exports = {
  publishArticle,
  startExistingArticleEditing,
  saveExistingArticleForPreview,
  autosaveExistingArticle,
  discardExistingArticleEdits,
  saveExistingArticleAsDraft,
  clearEditExistingBackup,
  startEditAsNewArticle,
  autosaveEditAsNewArticle,
  discardEditAsNewArticle,
  saveEditAsNewArticleAsDraft,
  startPublishedArticleEditing,
  autosavePublishedArticle,
  savePublishedArticleForPreview,
  republishArticle,
  discardPublishedArticleEdits,
};
