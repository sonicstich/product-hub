// GET /api/auth/login → redirect to Slack's "Sign in with Slack" consent.
const crypto = require('crypto');
const auth = require('../../lib/auth');

module.exports = (req, res) => {
  if (!auth.authConfigured()) return res.status(500).send('Slack sign-in is not configured.');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `ph_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  res.writeHead(302, { Location: auth.authorizeUrl(redirectUri, state) });
  res.end();
};
