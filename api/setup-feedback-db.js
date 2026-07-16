// TEMPORARY one-time setup endpoint — creates the feedback database in Notion
// using the app's own OAuth token, then returns its id. Guarded by a token so
// it can't be triggered casually during the brief window it's deployed. DELETE
// this file (and the setupFeedbackDb helper) after the db id is captured.
const notion = require('../lib/notion');

module.exports = async (req, res) => {
  if ((req.query && req.query.token) !== 'setup-fb-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    res.status(200).json(await notion.setupFeedbackDb());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
