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
app.post('/api/incidents',   async (req, res) => { try { res.status(201).json(await store.createIncident(req.body || {})); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
app.patch('/api/incidents',  wrap(req => { const { id, ...p } = req.body || {}; return store.updateIncident(id, p); }));
app.delete('/api/incidents', wrap(req => store.deleteIncident((req.body && req.body.id) || req.query.id)));

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
