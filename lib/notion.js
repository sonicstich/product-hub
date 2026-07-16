// lib/notion.js — shared Notion helpers.
// Used by BOTH the local Express server (server.js) and the Vercel
// serverless functions (api/*.js) so the logic never drifts between them.
//
// Auth: prefers a static NOTION_TOKEN (workspace API token) when present;
// otherwise uses an OAuth access token obtained via the /api/notion-connect
// flow and stored (with its refresh token) in Supabase. Notion OAuth access
// tokens can expire, so requests auto-refresh once on a 401 and persist the
// rotated tokens; if the refresh fails, the caller is told to reconnect.

const NOTION_DB_ID   = '102bba654d624b6bbd995720f8b245ba';
const SPRINTS_DB_ID  = '91ffe250e049481782dfda0016cd7a89'; // "Sprints" database
const FEEDBACK_DB_ID = () => process.env.NOTION_FEEDBACK_DB_ID; // "User feedback" database (env-configured)
const NOTION_API     = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const FEEDBACK_IMPORTANCE = ['Low', 'Medium', 'High'];

// Error that carries an HTTP status code so callers can map it to a response.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const OAUTH_CLIENT_ID     = () => process.env.NOTION_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = () => process.env.NOTION_OAUTH_CLIENT_SECRET;
const oauthConfigured     = () => !!(OAUTH_CLIENT_ID() && OAUTH_CLIENT_SECRET());

// Lazy require to keep the module graph simple (store.js never requires this).
let _store;
const store = () => (_store || (_store = require('./store')));

const NOT_CONNECTED = 'Notion is not connected. Open /api/notion-connect to authorize.';

// In-memory cache of the active token so we don't read Supabase on every call.
let _tok = null; // { access_token, refresh_token, static }

async function loadToken(force) {
  if (process.env.NOTION_TOKEN) return { access_token: process.env.NOTION_TOKEN, static: true };
  if (_tok && !force) return _tok;
  const row = await store().getOAuthToken('notion');
  _tok = row ? { access_token: row.access_token, refresh_token: row.refresh_token, static: false } : null;
  return _tok;
}

async function refreshAccessToken() {
  const tok = await loadToken(true);
  if (!tok || tok.static || !tok.refresh_token) throw new HttpError(401, NOT_CONNECTED);
  if (!oauthConfigured()) throw new HttpError(500, 'NOTION_OAUTH_CLIENT_ID / NOTION_OAUTH_CLIENT_SECRET not set');
  const basic = Buffer.from(`${OAUTH_CLIENT_ID()}:${OAUTH_CLIENT_SECRET()}`).toString('base64');
  const resp = await fetch(`${NOTION_API}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new HttpError(401, 'Notion needs to be reconnected. Open /api/notion-connect.');
  const saved = await store().saveOAuthToken('notion', data);
  _tok = { access_token: saved.access_token, refresh_token: saved.refresh_token, static: false };
  return _tok;
}

// Authenticated Notion API call. Retries once on 401 by refreshing the token
// (only when using an OAuth token — a static token can't be refreshed).
async function napi(path, opts = {}, _retried = false) {
  const tok = await loadToken();
  if (!tok || !tok.access_token) throw new HttpError(401, NOT_CONNECTED);
  const resp = await fetch(`${NOTION_API}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${tok.access_token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (resp.status === 401 && !tok.static && !_retried) {
    await refreshAccessToken();
    return napi(path, opts, true);
  }
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new HttpError(resp.status, (data && data.message) || 'Notion error');
  return data;
}

// ── OAuth handshake (used by api/notion-connect + api/notion-callback) ──
function authorizeUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID(),
    response_type: 'code',
    owner: 'user',
    redirect_uri: redirectUri,
  });
  if (state) p.set('state', state);
  return `${NOTION_API}/oauth/authorize?${p.toString()}`;
}

async function exchangeCode(code, redirectUri) {
  if (!code) throw new HttpError(400, 'Missing authorization code');
  if (!oauthConfigured()) throw new HttpError(500, 'NOTION_OAUTH_CLIENT_ID / NOTION_OAUTH_CLIENT_SECRET not set');
  const basic = Buffer.from(`${OAUTH_CLIENT_ID()}:${OAUTH_CLIENT_SECRET()}`).toString('base64');
  const resp = await fetch(`${NOTION_API}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new HttpError(resp.status, (data && (data.error_description || data.error)) || 'Notion token exchange failed');
  const saved = await store().saveOAuthToken('notion', data);
  _tok = { access_token: saved.access_token, refresh_token: saved.refresh_token, static: false };
  return data; // includes workspace_name, bot_id, etc.
}

// Is Notion usable right now? (static token present, or a stored OAuth token)
async function notionReady() {
  if (process.env.NOTION_TOKEN) return true;
  const row = await store().getOAuthToken('notion');
  return !!(row && row.access_token);
}

// ── Task operations ────────────────────────────────────────────────────

// Turn free-text description into Notion paragraph blocks for the page body.
// One block per line (blank lines kept as empty paragraphs); long lines are
// chunked to Notion's 2000-char rich_text limit; capped at 100 blocks/create.
function descriptionBlocks(text) {
  const t = (text || '').trim();
  if (!t) return [];
  const para = content => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: content ? [{ type: 'text', text: { content } }] : [] },
  });
  const blocks = [];
  for (const line of t.split('\n')) {
    if (line.length <= 2000) blocks.push(para(line));
    else for (let i = 0; i < line.length; i += 2000) blocks.push(para(line.slice(i, i + 2000)));
  }
  return blocks.slice(0, 100);
}

async function createTask(body) {
  const { title, why, metric, priority, criticalReason, dueDate, areas, otherAreaText, mockupLink, mockupFileNames, description } = body || {};
  if (!title?.trim()) throw new HttpError(400, 'Title is required');

  // Build the Why text, appending Other area + attached filenames if present.
  let whyText = why?.trim() || '';
  if (otherAreaText)           whyText += `\n\nOther area: ${otherAreaText}`;
  if (mockupFileNames?.length) whyText += `\n\nAttached files: ${mockupFileNames.join(', ')}`;

  const props = {
    Task:   { title: [{ text: { content: title.trim() } }] },
    Status: { select: { name: 'New' } },
  };
  if (whyText)      props['Why']             = { rich_text: [{ text: { content: whyText } }] };
  if (metric)       props['Metric']          = { rich_text: [{ text: { content: metric.trim() } }] };
  if (priority)     props['Priority']        = { select: { name: priority } };
  if (criticalReason && priority === 'Critical')
                    props['Critical Reason'] = { rich_text: [{ text: { content: criticalReason.trim() } }] };
  if (dueDate)      props['Due Date']        = { date: { start: dueDate } };
  if (areas?.length) props['Flow']           = { multi_select: areas.map(a => ({ name: a })) };
  if (mockupLink)   props['Mockup']          = { url: mockupLink.trim() };

  const payload = { parent: { database_id: NOTION_DB_ID }, properties: props };
  const children = descriptionBlocks(description);
  if (children.length) payload.children = children;

  const data = await napi('/pages', { method: 'POST', body: JSON.stringify(payload) });
  return { ok: true, url: data.url, id: data.id };
}

// Query all tasks from the Notion database, sorted by due date.
async function listTasks() {
  const data = await napi(`/databases/${NOTION_DB_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({ sorts: [{ property: 'Due Date', direction: 'ascending' }], page_size: 100 }),
  });
  const tasks = data.results.map(page => ({
    id:       page.id,
    url:      page.url,
    title:    page.properties.Task?.title?.[0]?.text?.content || 'Untitled',
    status:   page.properties.Status?.select?.name || 'New',
    priority: page.properties.Priority?.select?.name || null,
    dueDate:  page.properties['Due Date']?.date?.start || null,
    metric:   page.properties.Metric?.rich_text?.[0]?.text?.content || null,
    flow:     page.properties.Flow?.multi_select?.map(s => s.name) || [],
  }));
  return { tasks };
}

// Create a user-feedback entry in the feedback Notion database. The DB id
// comes from NOTION_FEEDBACK_DB_ID (create the DB in Notion, add the Product
// Hub connection to it, then set the id). Properties expected on the DB:
//   Title (title) · Description (text) · Users affected (number) ·
//   Importance (select: Low/Medium/High) · User ID (text)
async function createFeedback(body) {
  const { title, description, users, importance, userId } = body || {};
  if (!title?.trim()) throw new HttpError(400, 'Title is required');
  if (!FEEDBACK_DB_ID()) throw new HttpError(500, 'NOTION_FEEDBACK_DB_ID is not set — create the feedback database in Notion and set its id.');

  const props = { Title: { title: [{ text: { content: title.trim() } }] } };
  if (description?.trim()) props['Description'] = { rich_text: [{ text: { content: description.trim().slice(0, 1900) } }] };
  if (users != null && users !== '') {
    const n = Number(users);
    if (!Number.isNaN(n)) props['Users affected'] = { number: n };
  }
  if (FEEDBACK_IMPORTANCE.includes(importance)) props['Importance'] = { select: { name: importance } };
  if (userId?.trim()) props['User ID'] = { rich_text: [{ text: { content: userId.trim().slice(0, 200) } }] };

  const data = await napi('/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { database_id: FEEDBACK_DB_ID() }, properties: props }),
  });
  return { ok: true, url: data.url, id: data.id };
}

// Return the current sprint — the Sprints DB row whose Status = "Current".
async function getCurrentSprint() {
  const data = await napi(`/databases/${SPRINTS_DB_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { property: 'Status', status: { equals: 'Current' } }, page_size: 5 }),
  });
  const page = data.results.find(p => p.properties?.['Sprint name']?.title?.length);
  if (!page) return { current: null };

  const name = page.properties['Sprint name'].title.map(t => t.plain_text).join('');
  const numMatch = name.match(/\d+/);
  const date = page.properties['Dates']?.date || {};
  const goal = (page.properties['Goal']?.rich_text || []).map(t => t.plain_text).join('');

  return {
    current: {
      number: numMatch ? Number(numMatch[0]) : null,
      name,
      start: date.start || null,
      end:   date.end   || null,
      goal:  goal       || null,
    },
  };
}

module.exports = {
  createTask, listTasks, getCurrentSprint, createFeedback,
  authorizeUrl, exchangeCode, oauthConfigured, notionReady,
  HttpError,
};
