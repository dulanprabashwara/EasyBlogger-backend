const prisma = require("../config/prisma");
//get popular topics from article tags
 
const getPopularTags = async (limit = 10) => {
  const popularTags = await prisma.$queryRaw`
    SELECT LOWER(tag) as name, COUNT(*)::int as count 
    FROM (
      SELECT unnest(tags) as tag
      FROM articles
      WHERE status = 'PUBLISHED' OR status = 'REPUBLISHED'
      AND "publishedAt" >= NOW() - INTERVAL '14 days'
    ) as flattened_tags
    GROUP BY LOWER(tag)
    ORDER BY count DESC
    LIMIT ${parseInt(limit)};
  `;

  return popularTags;
};

module.exports = {
  getPopularTags,
};