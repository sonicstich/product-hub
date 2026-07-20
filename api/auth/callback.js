// GET /api/auth/callback → verify state, exchange the code, restrict to our
// Slack workspace, set the session cookie, and return to the app.
const auth = require('../../lib/auth');

const readCookie = (req, name) => {
  const m = ('; ' + (req.headers.cookie || '')).match(new RegExp('; ' + name + '=([^;]+)'));
  return m ? m[1] : null;
};
const page = msg => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<div style="font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:460px;margin:14vh auto;padding:0 24px;text-align:center;color:#1a1a1a">${msg}</div>`;

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    if (q.error) return res.status(400).send(page('Sign-in was cancelled.'));
    const state = readCookie(req, 'ph_oauth_state');
    if (!state || state !== q.state) return res.status(400).send(page('Sign-in expired or invalid — please try again.'));

    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host  = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${proto}://${host}/api/auth/callback`;

    const user = await auth.exchangeCode(q.code, redirectUri);
    const allowed = await auth.allowedTeamId();
    if (allowed && user.teamId !== allowed) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(403).send(page('⛔️ This Product Hub is restricted to the CUSP Slack workspace.<br><br>Sign in with your work account.'));
    }
    const jwt = auth.signSession({ sub: user.userId, name: user.name, email: user.email, team: user.teamId, pic: user.picture });
    res.setHeader('Set-Cookie', [auth.sessionSetCookie(jwt), 'ph_oauth_state=; Path=/; Max-Age=0']);
    res.writeHead(302, { Location: '/' });
    res.end();
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(500).send(page('Sign-in error: ' + err.message));
  }
};
