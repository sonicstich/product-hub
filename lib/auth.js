// lib/auth.js — "Sign in with Slack" (OpenID Connect) + a signed session
// cookie. No external deps: the session is a small HS256 JWT we sign/verify
// with Node crypto (the Edge middleware verifies the same token with Web
// Crypto). Auth is OFF unless SLACK_CLIENT_ID + SLACK_CLIENT_SECRET +
// SESSION_SECRET are all set — so deploying this never locks anyone out.

const crypto = require('crypto');

const CLIENT_ID      = () => process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET  = () => process.env.SLACK_CLIENT_SECRET;
const SECRET         = () => process.env.SESSION_SECRET;
const authConfigured = () => !!(CLIENT_ID() && CLIENT_SECRET() && SECRET());

const COOKIE  = 'ph_session';
const MAX_AGE = 7 * 24 * 3600; // 7 days
const SLACK_OIDC = 'https://slack.com/openid/connect';

const b64urlJSON = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

function signSession(payload) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlJSON({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJSON({ ...payload, iat: now, exp: now + MAX_AGE });
  const data = `${head}.${body}`;
  const sig = crypto.createHmac('sha256', SECRET()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || !SECRET()) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', SECRET()).update(data).digest('base64url');
  const a = Buffer.from(parts[2]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch (_) { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function readCookie(req, name) {
  const h = (req.headers && (req.headers.cookie || (req.headers.get && req.headers.get('cookie')))) || '';
  const m = ('; ' + h).match(new RegExp('; ' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function getSession(req) { return verifySession(readCookie(req, COOKIE)); }
function sessionSetCookie(jwt)  { return `${COOKIE}=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`; }
function sessionClearCookie()   { return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`; }

function authorizeUrl(redirectUri, state) {
  const p = new URLSearchParams({
    response_type: 'code',
    scope: 'openid email profile',
    client_id: CLIENT_ID(),
    redirect_uri: redirectUri,
    state,
  });
  return `${SLACK_OIDC}/authorize?${p.toString()}`;
}

// Exchange the OAuth code for the signed-in user's identity.
async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(),
    code, grant_type: 'authorization_code', redirect_uri: redirectUri,
  });
  const resp = await fetch(`${SLACK_OIDC}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await resp.json();
  if (!data.ok) throw new Error('Slack sign-in failed: ' + (data.error || resp.status));
  // id_token came directly from Slack over TLS; read its claims (no re-verify needed).
  const claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
  return {
    userId: claims['https://slack.com/user_id'] || claims.sub,
    teamId: claims['https://slack.com/team_id'],
    name:   claims.name,
    email:  claims.email,
    picture: claims.picture,
  };
}

// Allowed workspace = the bot's own workspace (from auth.test), cached in
// memory. Override with SLACK_ALLOWED_TEAM_ID if you ever need a different one.
let _allowedTeam;
async function allowedTeamId() {
  if (process.env.SLACK_ALLOWED_TEAM_ID) return process.env.SLACK_ALLOWED_TEAM_ID;
  if (_allowedTeam !== undefined) return _allowedTeam;
  try {
    const r = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
    const d = await r.json();
    _allowedTeam = d.ok ? d.team_id : null;
  } catch (_) { _allowedTeam = null; }
  return _allowedTeam;
}

module.exports = {
  authConfigured, authorizeUrl, exchangeCode, allowedTeamId,
  signSession, verifySession, getSession, sessionSetCookie, sessionClearCookie,
  COOKIE,
};
