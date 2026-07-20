// Vercel serverless function → all Slack sign-in routes in ONE function
// (Hobby plan caps deployments at 12 functions). A vercel.json rewrite maps
// /api/auth/:action → /api/auth?action=:action, so the clean URLs
// /api/auth/{login,callback,me,logout} still work.
const crypto = require('crypto');
const auth = require('../lib/auth');

const readCookie = (req, name) => {
  const m = ('; ' + (req.headers.cookie || '')).match(new RegExp('; ' + name + '=([^;]+)'));
  return m ? m[1] : null;
};
const page = msg => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<div style="font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:460px;margin:14vh auto;padding:0 24px;text-align:center;color:#1a1a1a">${msg}</div>`;

module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || '';
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  if (action === 'login') {
    if (!auth.authConfigured()) return res.status(500).send('Slack sign-in is not configured.');
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `ph_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
    res.writeHead(302, { Location: auth.authorizeUrl(redirectUri, state) });
    return res.end();
  }

  if (action === 'callback') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    try {
      const q = req.query || {};
      if (q.error) return res.status(400).send(page('Sign-in was cancelled.'));
      const state = readCookie(req, 'ph_oauth_state');
      if (!state || state !== q.state) return res.status(400).send(page('Sign-in expired or invalid — please try again.'));
      const user = await auth.exchangeCode(q.code, redirectUri);
      const allowed = await auth.allowedTeamId();
      if (allowed && user.teamId !== allowed) return res.status(403).send(page('⛔️ This Product Hub is restricted to the CUSP Slack workspace.<br><br>Sign in with your work account.'));
      const jwt = auth.signSession({ sub: user.userId, name: user.name, email: user.email, team: user.teamId, pic: user.picture });
      res.setHeader('Set-Cookie', [auth.sessionSetCookie(jwt), 'ph_oauth_state=; Path=/; Max-Age=0']);
      res.writeHead(302, { Location: '/' });
      return res.end();
    } catch (err) {
      return res.status(500).send(page('Sign-in error: ' + err.message));
    }
  }

  if (action === 'me') {
    if (!auth.authConfigured()) return res.status(200).json({ authEnabled: false, authenticated: false });
    const s = auth.getSession(req);
    if (!s) return res.status(401).json({ authEnabled: true, authenticated: false });
    return res.status(200).json({ authEnabled: true, authenticated: true, user: { id: s.sub, name: s.name, email: s.email, picture: s.pic } });
  }

  if (action === 'logout') {
    res.setHeader('Set-Cookie', auth.sessionClearCookie());
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  res.status(404).json({ error: 'Unknown auth action' });
};
