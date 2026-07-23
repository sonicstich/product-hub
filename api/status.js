// Vercel serverless function → GET /api/status (health check)
const { storageConfigured } = require('../lib/store');
const { notionReady, oauthConfigured, createTask } = require('../lib/notion');
const { slackConfigured } = require('../lib/slack');

module.exports = async (req, res) => {
  // TEMP: /api/status?taskboard=1 creates a test task on the Discovery Sprints
  // board and returns the result/error. Remove once verified.
  if (req.query && req.query.taskboard) {
    try {
      const t = await createTask(
        { title: '[diagnostic] Discovery board test', why: 'why text', metric: 'metric', priority: 'High', dueDate: '2026-07-30', areas: ['Deposits'], description: 'Temporary — safe to delete.' },
        { submittedBy: 'Diagnostic' },
      );
      return res.status(200).json({ ok: true, task: t });
    } catch (e) { return res.status(200).json({ ok: false, error: e && e.message, status: e && e.status }); }
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
