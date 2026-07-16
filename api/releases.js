// Vercel serverless function → /api/releases (GET list, POST/PATCH upsert)
const store = require('../lib/store');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') return res.status(200).json(await store.listReleases());
    if (req.method === 'POST' || req.method === 'PATCH') return res.status(200).json(await store.saveRelease(req.body || {}));
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
