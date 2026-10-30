const prisma = require("../config/prisma");

//get article titles,author name based on trending scroe
const fetchTrendingTitles = async () => {
    const limit = 5;
  return await prisma.article.findMany({
     where: {status: { in: ["PUBLISHED", "REPUBLISHED"] } },
    orderBy: { trendingScore: 'desc' },
    take: limit,
    select: {
      id: true,
      title: true,
      createdAt: true,
      author: {
        select: { displayName: true }
      }
    }
  });
};

//get trending articles as a whole
const fetchTrendingArticles = async () => {
const limit = 10;

return await prisma.article.findMany({
    where: { status: { in: ["PUBLISHED", "REPUBLISHED"] } }, 
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
  fetchTrendingTitles,
  fetchTrendingArticles
};