const prisma = require("../config/prisma");

const fetchTopUserArticles = async (userId) => {
  // Changed limit to 5
  const limit = 5;

  return await prisma.article.findMany({
    where: { 
      status: { in: ["PUBLISHED", "REPUBLISHED"] },
      authorId: userId // Filters articles pertaining ONLY to the current user
    }, 
    orderBy: { trendingScore: "desc" },
    take: limit,
    include: {
      author: {
        select: {
          displayName: true,
          username: true,
          avatarUrl: true,
        },
      },
    },
  });
};

module.exports = {
  fetchTopUserArticles,
};