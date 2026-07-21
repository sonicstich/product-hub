// Vercel serverless function → POST /api/create-task
const { createTask, HttpError } = require('../lib/notion');
const { denyUnauth, getSession } = require('../lib/auth');

module.exports = async (req, res) => {
  if (denyUnauth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const s = getSession(req);
    res.status(200).json(await createTask(req.body, { submittedBy: s && (s.name || s.email) }));
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message });
  }
};
