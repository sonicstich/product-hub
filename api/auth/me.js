// GET /api/auth/me → current signed-in user (or 401). Also reports whether
// auth is even enabled, so the UI can hide the account chip when it's off.
const auth = require('../../lib/auth');

module.exports = (req, res) => {
  if (!auth.authConfigured()) return res.status(200).json({ authEnabled: false, authenticated: false });
  const s = auth.getSession(req);
  if (!s) return res.status(401).json({ authEnabled: true, authenticated: false });
  res.status(200).json({ authEnabled: true, authenticated: true, user: { id: s.sub, name: s.name, email: s.email, picture: s.pic } });
};
