// Vercel serverless function → /api/incidents  (GET list · POST create · PATCH update · DELETE)
const { listIncidents, createIncident, updateIncident, deleteIncident, HttpError } = require('../lib/store');
const { getSession, denyUnauth } = require('../lib/auth');

module.exports = async (req, res) => {
  if (denyUnauth(req, res)) return;
  // Limited "reporter" accounts (external contractors) may view + create
  // incidents (GET/POST) but not edit, change status, or delete (PATCH/DELETE).
  const s = getSession(req);
  if (s && s.role === 'reporter' && req.method !== 'GET' && req.method !== 'POST') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    if (req.method === 'GET')  return res.status(200).json(await listIncidents());
    if (req.method === 'POST') {
      const rid = s && s.sub;
      return res.status(201).json(await createIncident(req.body || {}, { reporterId: rid && !String(rid).startsWith('email:') ? rid : null, reporterName: s && (s.name || s.email) }));
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
