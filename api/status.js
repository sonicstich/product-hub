// Vercel serverless function → GET /api/status (health check)
module.exports = (req, res) => {
  res.status(200).json({ ok: true, notionConfigured: !!process.env.NOTION_TOKEN });
};
