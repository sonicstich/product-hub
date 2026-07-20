// server.js — LOCAL development server only.
// On Vercel the app runs as static files (public/) + serverless functions (api/);
// this Express server reproduces that locally so you can `npm run dev`.

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { createTask, listTasks, getCurrentSprint, createFeedback, authorizeUrl, exchangeCode, oauthConfigured, notionReady, HttpError } = require('./lib/notion');
const store = require('./lib/store');
const { slackConfigured } = require('./lib/slack');
const authLib = require('./lib/auth');
const crypto = require('crypto');

// Load .env manually for local dev (Vercel injects env vars on its own).
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .forEach(l => {
      const [k, ...v] = l.split('=');
      process.env[k.trim()] = v.join('=').trim();
    });
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Gate all /api routes behind Slack sign-in (except the auth flow + health).
// No-op when auth isn't configured (fail-open, same as production).
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path === '/status') return next();
  if (authLib.denyUnauth(req, res)) return;
  next();
});

app.post('/api/create-task', async (req, res) => {
  try { res.json(await createTask(req.body)); }
  catch (err) { res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }); }
});

app.get('/api/tasks', async (req, res) => {
  try { res.json(await listTasks()); }
  catch (err) { res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }); }
});

app.post('/api/create-feedback', async (req, res) => {
  try { res.json(await createFeedback(req.body)); }
  catch (err) { res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }); }
});

app.get('/api/current-sprint', async (req, res) => {
  try { res.json(await getCurrentSprint()); }
  catch (err) { res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }); }
});

// Notion OAuth handshake (mirrors api/notion-connect.js + api/notion-callback.js)
app.get('/api/notion-connect', (req, res) => {
  if (!oauthConfigured()) return res.status(500).send('NOTION_OAUTH_CLIENT_ID / NOTION_OAUTH_CLIENT_SECRET are not set.');
  const redirectUri = `${req.protocol}://${req.get('host')}/api/notion-callback`;
  res.redirect(authorizeUrl(redirectUri));
});
app.get('/api/notion-callback', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    if (req.query.error) return res.status(400).send(`Authorization failed: ${req.query.error}`);
    const redirectUri = `${req.protocol}://${req.get('host')}/api/notion-callback`;
    const data = await exchangeCode(req.query.code, redirectUri);
    res.send(`✅ Connected to Notion workspace "${data.workspace_name || ''}". You can close this tab — Create Task now works.`);
  } catch (err) {
    res.status(err.status || 500).send(`Error: ${err.message}`);
  }
});

// Incidents (same handlers the Vercel function uses)
const wrap = fn => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (err) { res.status(err instanceof HttpError || err.status ? err.status : 500).json({ error: err.message }); }
};
app.get('/api/releases',  wrap(() => store.listReleases()));
app.post('/api/releases', async (req, res) => { try { res.json(await store.saveRelease(req.body || {})); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });

app.get('/api/incidents',    wrap(req => store.listIncidents()));
app.post('/api/incidents',   async (req, res) => { try { const s = authLib.getSession(req); res.status(201).json(await store.createIncident(req.body || {}, { reporterId: s && s.sub })); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
app.patch('/api/incidents',  wrap(req => { const { id, ...p } = req.body || {}; return store.updateIncident(id, p); }));
app.delete('/api/incidents', wrap(req => store.deleteIncident((req.body && req.body.id) || req.query.id)));

// Slack sign-in (mirrors api/auth/*) — local dev only exercises these if creds are set.
app.get('/api/auth/login', (req, res) => {
  if (!authLib.authConfigured()) return res.status(500).send('Slack sign-in is not configured.');
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `ph_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
  res.redirect(authLib.authorizeUrl(redirectUri, state));
});
app.get('/api/auth/callback', async (req, res) => {
  try {
    if (req.query.error) return res.status(400).send('Sign-in cancelled.');
    const st = (req.headers.cookie || '').match(/ph_oauth_state=([^;]+)/);
    if (!st || st[1] !== req.query.state) return res.status(400).send('Sign-in expired — try again.');
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/callback`;
    const user = await authLib.exchangeCode(req.query.code, redirectUri);
    const allowed = await authLib.allowedTeamId();
    if (allowed && user.teamId !== allowed) return res.status(403).send('Restricted to the CUSP Slack workspace.');
    const jwt = authLib.signSession({ sub: user.userId, name: user.name, email: user.email, team: user.teamId, pic: user.picture });
    res.setHeader('Set-Cookie', [authLib.sessionSetCookie(jwt), 'ph_oauth_state=; Path=/; Max-Age=0']);
    res.redirect('/');
  } catch (e) { res.status(500).send('Sign-in error: ' + e.message); }
});
app.get('/api/auth/me', (req, res) => {
  if (!authLib.authConfigured()) return res.json({ authEnabled: false, authenticated: false });
  const s = authLib.getSession(req);
  if (!s) return res.status(401).json({ authEnabled: true, authenticated: false });
  res.json({ authEnabled: true, authenticated: true, user: { id: s.sub, name: s.name, email: s.email, picture: s.pic } });
});
app.get('/api/auth/logout', (req, res) => { res.setHeader('Set-Cookie', authLib.sessionClearCookie()); res.redirect('/'); });

app.get('/api/status', async (req, res) => {
  let notionConnected = false;
  try { notionConnected = await notionReady(); } catch (_) {}
  res.json({
    ok: true,
    notionConfigured: !!process.env.NOTION_TOKEN,
    notionConnected,
    oauthConfigured: oauthConfigured(),
    slackConfigured: slackConfigured(),
    storageConfigured: store.storageConfigured(),
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Product Hub → http://localhost:${PORT}/`);
  if (!process.env.NOTION_TOKEN) {
    console.warn('\n⚠️  NOTION_TOKEN not set — Create Task will not work locally. Add it to .env\n');
  }
});
