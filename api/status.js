// Vercel serverless function → GET /api/status (health check)
const { storageConfigured } = require('../lib/store');
const { notionReady, oauthConfigured } = require('../lib/notion');

module.exports = async (req, res) => {
  let notionConnected = false;
  try { notionConnected = await notionReady(); } catch (_) {}
  res.status(200).json({
    ok: true,
    notionConfigured: !!process.env.NOTION_TOKEN,
    notionConnected,
    oauthConfigured: oauthConfigured(),
    storageConfigured: storageConfigured(),
  });
};
