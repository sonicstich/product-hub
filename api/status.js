// Vercel serverless function → GET /api/status (health check)
const { storageConfigured } = require('../lib/store');
const { notionReady, oauthConfigured, createBugTask } = require('../lib/notion');
const { slackConfigured } = require('../lib/slack');

module.exports = async (req, res) => {
  // TEMP: /api/status?bugtask=1&assignee=<notion-id> verifies task creation +
  // assignment. Remove once confirmed.
  if (req.query && req.query.bugtask) {
    try {
      const task = await createBugTask(
        { title: '[diagnostic] assignee test', description: 'Temporary — safe to delete.', priority: 'Low', platforms: ['iOS'], areas: ['Deposits'], userLinks: [] },
        { reporterName: 'Diagnostic', assigneeId: req.query.assignee || '' },
      );
      return res.status(200).json({ ok: true, task });
    } catch (e) { return res.status(200).json({ ok: false, error: e && e.message }); }
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
