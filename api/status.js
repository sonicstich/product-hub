// Vercel serverless function → GET /api/status (health check)
const { storageConfigured } = require('../lib/store');
const { notionReady, oauthConfigured, createBugTask } = require('../lib/notion');
const { slackConfigured } = require('../lib/slack');

module.exports = async (req, res) => {
  // TEMP diagnostic: /api/status?bugtask=1 runs the real bug-task create and
  // returns the exact Notion error. Remove once the integration is verified.
  if (req.query && req.query.bugtask) {
    try {
      const task = await createBugTask({
        title: '[diagnostic] Product Hub bug-task test',
        description: 'Temporary test — safe to delete.',
        priority: 'High', platforms: ['iOS'], areas: ['Deposits'], userLinks: [],
      });
      return res.status(200).json({ ok: true, task });
    } catch (e) {
      return res.status(200).json({ ok: false, error: e && e.message, status: e && e.status });
    }
  }
  let notionConnected = false;
  try { notionConnected = await notionReady(); } catch (_) {}
  res.status(200).json({
    ok: true,
    notionConfigured: !!process.env.NOTION_TOKEN,
    notionConnected,
    oauthConfigured: oauthConfigured(),
    slackConfigured: slackConfigured(),
    storageConfigured: storageConfigured(),
  });
};
