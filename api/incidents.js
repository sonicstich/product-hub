// Vercel serverless function → /api/incidents  (GET list · POST create · PATCH update · DELETE)
const { listIncidents, createIncident, updateIncident, deleteIncident, HttpError } = require('../lib/store');
const { getSession, denyUnauth } = require('../lib/auth');

module.exports = async (req, res) => {
  if (denyUnauth(req, res)) return;
  try {
    if (req.method === 'GET')  return res.status(200).json(await listIncidents());
    if (req.method === 'POST') {
      const s = getSession(req);
      return res.status(201).json(await createIncident(req.body || {}, { reporterId: s && s.sub }));
    }
    if (req.method === 'PATCH') {
      const { id, ...patch } = req.body || {};
      return res.status(200).json(await updateIncident(id, patch));
    }
    if (req.method === 'DELETE') {
      const id = (req.body && req.body.id) || req.query.id;
      return res.status(200).json(await deleteIncident(id));
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message });
  }
};
