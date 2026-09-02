// Vercel serverless function → GET /api/status (health check)
const { storageConfigured } = require('../lib/store');
const { notionReady, oauthConfigured, uploadNotionImage, createBugTask } = require('../lib/notion');
const { slackConfigured, diagImages } = require('../lib/slack');

module.exports = async (req, res) => {
  // TEMP: /api/status?imgtest=1 tests screenshot upload to Notion + Slack.
  if (req.query && req.query.imgtest) {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const out = {};
    try { const fid = await uploadNotionImage(png); out.notion = fid ? { ok: true, fileId: fid } : { ok: false }; } catch (e) { out.notion = { error: e && e.message }; }
    try { out.notionTask = await createBugTask({ title: '[img diag] full task', priority: 'Low', platforms: ['iOS'], areas: ['Deposits'], description: 'diag', images: [png] }, {}); } catch (e) { out.notionTask = { error: e && e.message }; }
    try { out.slack = await diagImages(png); } catch (e) { out.slack = { error: e && e.message }; }
    return res.status(200).json(out);
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
