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
const FEEDBACK_DB_ID = () => process.env.NOTION_FEEDBACK_DB_ID || '39fa512e26198132a8c7c6f6b2a5729c'; // "Product Hub — User Feedback" DB
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
// A Notion paragraph block. Empty content → a blank paragraph.
function paraBlock(content) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: content ? [{ type: 'text', text: { content } }] : [] } };
}

function descriptionBlocks(text) {
  const t = (text || '').trim();
  if (!t) return [];
  const blocks = [];
  for (const line of t.split('\n')) {
    if (line.length <= 2000) blocks.push(paraBlock(line));
    else for (let i = 0; i < line.length; i += 2000) blocks.push(paraBlock(line.slice(i, i + 2000)));
  }
  return blocks.slice(0, 100);
}

async function createTask(body, opts = {}) {
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
  if (opts.submittedBy) children.unshift(paraBlock(`👤 Created by ${opts.submittedBy}`));
  if (children.length) payload.children = children.slice(0, 100);

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
async function createFeedback(body, opts = {}) {
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

  const payload = { parent: { database_id: FEEDBACK_DB_ID() }, properties: props };
  if (opts.submittedBy) payload.children = [paraBlock(`👤 Shared by ${opts.submittedBy}`)];

  const data = await napi('/pages', { method: 'POST', body: JSON.stringify(payload) });
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
      id:     page.id,
      number: numMatch ? Number(numMatch[0]) : null,
      name,
      start: date.start || null,
      end:   date.end   || null,
      goal:  goal       || null,
    },
  };
}

// ── Dev bug task on the "Delivery Sprint Board" ──────────────────────────
// When an incident is reported we auto-create a matching dev task on the
// engineering board and drop its link into the incident's Slack thread.
// This writes to a DIFFERENT database than createTask() (which uses the
// product "Tasks" DB). Property names below are verbatim from that board's
// schema — the title property has a blank name, Status is a status type.
//
// Requires the Product Hub Notion integration to be shared with the Delivery
// Sprint Board (and the Features Backlog + Sprints DBs, for the relations).
// Best-effort: returns null when Notion isn't connected; the caller wraps
// this in try/catch so a failure never blocks creating the incident.
// The Delivery Sprint Board is a "data source" model database, so pages must
// be created against its data_source_id with the 2025-09-03 API (passing a
// database_id parent under the old API is rejected). We resolve the data
// source id from the database at runtime — the hardcoded id can go stale, and
// the integration provably has access to the database itself.
const BUG_BOARD_DB_ID      = () => process.env.BUG_BOARD_DB_ID || '11534c66bbd14630bf52f4ffc1a419a9';
const BUG_BOARD_DS_ID      = () => process.env.BUG_BOARD_DS_ID || ''; // optional override
const BUG_BOARD_VERSION    = '2025-09-03';
const BUG_BOARD_FEATURE_ID = () => process.env.BUG_BOARD_FEATURE_PAGE_ID || '15fa512e261980e9bb17f43692519944'; // "QA bugs"

// Resolve the board's data source id. Prefers the env override; otherwise asks
// the database for its data_sources (2025-09-03 API) and uses the first.
async function boardDataSourceId() {
  if (BUG_BOARD_DS_ID()) return BUG_BOARD_DS_ID();
  const db = await napi(`/databases/${BUG_BOARD_DB_ID()}`, { headers: { 'Notion-Version': BUG_BOARD_VERSION } });
  const ds = db && Array.isArray(db.data_sources) ? db.data_sources[0] : null;
  if (!ds || !ds.id) throw new HttpError(500, 'Sprint Board has no accessible data source');
  return ds.id;
}
const BUG_PRIORITY_MAP     = { Critical: '4. Critical', High: '3. High', Medium: '2. Medium', Low: '1. Low' };
const BUG_TAG_OPTIONS      = ['iOS', 'Android'];

// Notion assignees for an incident, keyed by "Related to" area. Mirrors the
// Slack INCIDENT_ASSIGNEES map but with Notion user ids:
// INCIDENT_ASSIGNEES_NOTION = {"default":"<id>","Deposits":"<id>",...}.
// Values may be a single id or an array. Falls back to "default".
function notionAssigneesFor(areas) {
  let map = {};
  try { map = JSON.parse(process.env.INCIDENT_ASSIGNEES_NOTION || '{}'); } catch (_) {}
  const ids = new Set();
  const add = v => { if (Array.isArray(v)) v.forEach(x => x && ids.add(x)); else if (v) ids.add(v); };
  const arr = Array.isArray(areas) ? areas : [];
  if (!arr.length) { add(map.default); return [...ids]; }
  arr.forEach(a => add(map[a] != null ? map[a] : map.default));
  return [...ids];
}

// TEMP diagnostic: raw retrieve of the board database (2025-09-03) so we can
// see exactly what the app's integration gets back.
async function debugBoardDb() {
  const out = {};
  try {
    const v = await napi(`/databases/${BUG_BOARD_DB_ID()}`, { headers: { 'Notion-Version': BUG_BOARD_VERSION } });
    out.v2025 = { object: v.object, keys: Object.keys(v), data_sources: v.data_sources, is_inline: v.is_inline, parent: v.parent };
  } catch (e) { out.v2025err = { message: e.message, status: e.status }; }
  try {
    const o = await napi(`/databases/${BUG_BOARD_DB_ID()}`);
    out.v2022 = { object: o.object, keys: Object.keys(o), has_properties: !!o.properties, parent: o.parent };
  } catch (e) { out.v2022err = { message: e.message, status: e.status }; }
  return out;
}

async function createBugTask(inc) {
  if (!(await notionReady())) return null; // Notion not connected — skip silently
  const title = (inc.title || 'Untitled incident').trim().slice(0, 200);

  const props = {
    '':       { title: [{ text: { content: title } }] }, // title property has a blank name
    'Type':   { select: { name: 'Bug' } },
    'Status': { status: { name: 'To do' } },
  };
  const pri = BUG_PRIORITY_MAP[inc.priority];
  if (pri) props['Priority'] = { select: { name: pri } };

  const tags = (inc.platforms || []).filter(p => BUG_TAG_OPTIONS.includes(p));
  if (tags.length) props['Tags'] = { multi_select: tags.map(t => ({ name: t })) };

  if (BUG_BOARD_FEATURE_ID()) props['Related to Features Backlog (Issues)'] = { relation: [{ id: BUG_BOARD_FEATURE_ID() }] };

  // Always file into the current sprint.
  try {
    const cur = await getCurrentSprint();
    if (cur && cur.current && cur.current.id) props['Sprint'] = { relation: [{ id: cur.current.id }] };
  } catch (_) {}

  // Assign to the same person the incident is assigned to (by area).
  const people = notionAssigneesFor(inc.areas);
  if (people.length) props['Assignee'] = { people: people.map(id => ({ id })) };

  const children = [paraBlock('🐛 Auto-created from a Product Hub incident report')];
  descriptionBlocks(inc.description).forEach(b => children.push(b));
  const userLinks = Array.isArray(inc.userLinks) ? inc.userLinks.slice(0, 10) : [];
  if (userLinks.length) children.push(paraBlock('Affected user(s) in admin: ' + userLinks.join('   ·   ')));

  const payload = {
    parent: { type: 'data_source_id', data_source_id: await boardDataSourceId() },
    properties: props,
    children: children.slice(0, 100),
  };
  const data = await napi('/pages', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Notion-Version': BUG_BOARD_VERSION },
  });
  return { ok: true, url: data.url, id: data.id };
}

module.exports = {
  createTask, listTasks, getCurrentSprint, createFeedback, createBugTask, debugBoardDb,
  authorizeUrl, exchangeCode, oauthConfigured, notionReady,
  HttpError,
};
