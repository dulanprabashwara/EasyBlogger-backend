const prisma = require("../config/prisma");

 
 //update comment count in article table
const updateCommentCount = async (articleId) => {
  try {
    //get the commentcount 
      const commentcount = await prisma.Comment.aggregate({
      where: { articleId: articleId },
      _count: { articleId: true }
    });

//set new comment cout
    const updatedArticle = await prisma.article.update({
      where: { id: articleId },
      data: {
        commentCount:commentcount ._count.articleId
      }
    });
    
    return updatedArticle;
  } catch (error) {
    console.error("Failed to update comment count:", error.message);
    throw error;
  }
};

/*
 Recalculates the total count and average score of an article's ratings,
 then updates the article record.
 */
const updateRatingStats = async (articleId) => {
  try {
    // Calculate the Average and the Count of all scores for this specific article
    const articleAggregations = await prisma.articleRating.aggregate({
      where: { articleId: articleId },
      _avg: { score: true },
      _count: { score: true }
    });

    const newArticleAverage = articleAggregations._avg.score || 0;
    const newArticleCount = articleAggregations._count.score || 0;

    //Update the Article table with the  calculated stats 
    const updatedArticle = await prisma.article.update({
      where: { id: articleId },
      data: {
        averageRating: newArticleAverage,
        ratingCount: newArticleCount
      }
    });

    const authorId = updatedArticle.authorId;

    //Calculate the new overall average rating for the author across ALL their articles
    const userAggregations = await prisma.articleRating.aggregate({
      where: {
        article: {
          authorId: authorId,
        },
      },
      _avg: { score: true },
    });

    const newUserAverage = userAggregations._avg.score || 0;

    // Update the UserStats table using upsert
    await prisma.userStats.upsert({
      where: { userId: authorId },
      update: {
        averageRating: newUserAverage,
      },
      create: {
        userId: authorId,
        averageRating: newUserAverage,
      },
    });

    return updatedArticle;
  } catch (error) {
    console.error("Failed to update rating stats:", error.message);
    throw error;
  }
};

const getAuthorArticleStats = async (userId) => {
  return await prisma.article.findMany({
    where: {
      authorId: userId,
      status: { in: ["PUBLISHED", "REPUBLISHED"] },
    },
    take:10,
    select: {
      id: true,
      title: true,
      publishedAt: true,
      readCount: true,
      averageRating: true,
      ratingCount: true,
      commentCount: true,
      status: true, // Useful if you want to filter out drafts later
      comments: {
        select: {
          id: true,
          content: true,
          author: {
            select: { displayName: true }
          }
        }
      },
      ratings: {
        select: {
          score: true
        }
      }
    },
    orderBy: {
      publishedAt: 'desc',
    },
    
  });
};
 

module.exports = { 
  updateCommentCount, 
  updateRatingStats,
  getAuthorArticleStats
};