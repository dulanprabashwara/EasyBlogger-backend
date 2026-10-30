const articleReadService = require("../services/articleRead.service"); // Adjust path if your service file is stored in a different folder

exports.getArticleById = async (req, res) => {
  const { id } = req.query; 

  console.log("--> BACKEND RECEIVED ID:", id);

  try {
    if (!id) {
      return res.status(400).json({ error: "Article ID is required" });
    }

    const article = await articleReadService.getFullArticleDetails(id);

    if (!article) {
      console.log(`--> ARTICLE NOT FOUND IN DB FOR ID: "${id}"`);
      return res.status(404).json({ error: "Article not found" });
    }

    res.status(200).json(article);
  } catch (error) {
    console.error("ARTICLE READ ERROR:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};