// Vercel serverless function → GET /api/current-sprint
const { getCurrentSprint, HttpError } = require('../lib/notion');
const { denyUnauth } = require('../lib/auth');

module.exports = async (req, res) => {
  if (denyUnauth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    res.status(200).json(await getCurrentSprint());
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message });
  }
};
