// server.js — LOCAL development server only.
// On Vercel the app runs as static files (public/) + serverless functions (api/);
// this Express server reproduces that locally so you can `npm run dev`.

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { createTask, listTasks, HttpError } = require('./lib/notion');

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

app.get('/api/status', (req, res) => {
  res.json({ ok: true, notionConfigured: !!process.env.NOTION_TOKEN });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Product Hub → http://localhost:${PORT}/`);
  if (!process.env.NOTION_TOKEN) {
    console.warn('\n⚠️  NOTION_TOKEN not set — Create Task will not work locally. Add it to .env\n');
  }
});
