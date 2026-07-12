// Vercel serverless function → GET /api/tasks
const { listTasks, HttpError } = require('../lib/notion');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    res.status(200).json(await listTasks());
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message });
  }
};
