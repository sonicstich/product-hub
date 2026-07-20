// GET /api/auth/logout → clear our session cookie. (Slack's own SSO session
// persists, so the next visit re-authenticates via Slack automatically.)
const auth = require('../../lib/auth');

module.exports = (req, res) => {
  res.setHeader('Set-Cookie', auth.sessionClearCookie());
  res.writeHead(302, { Location: '/' });
  res.end();
};
