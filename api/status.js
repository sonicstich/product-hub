// Vercel serverless function → GET /api/status (health check)
const { storageConfigured } = require('../lib/store');

module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    notionConfigured: !!process.env.NOTION_TOKEN,
    storageConfigured: storageConfigured(),
  });
};
