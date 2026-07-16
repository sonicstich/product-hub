// Vercel serverless function → POST /api/create-feedback
const { createFeedback, HttpError } = require('../lib/notion');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    res.status(200).json(await createFeedback(req.body));
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message });
  }
};
