// lib/store.js — persistence for incidents.
//
// Talks to a Supabase Postgres table over its auto-generated PostgREST API
// (plain fetch, no @supabase/supabase-js dependency needed — same style as
// lib/notion.js). Until SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set — and
// for local dev without them — it falls back to an in-memory store so the
// app still runs (in-memory data is per-instance, NOT shared or persisted).

const slackLib = require('./slack');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = () => !!(SUPABASE_URL && SERVICE_KEY);
const restUrl = (table) => `${SUPABASE_URL}/rest/v1/${table}`;
const headers = (extra = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

const mem = [];        // in-memory fallback — incident rows (camelCase, same shape as DB rows below)
const memTokens = {};  // in-memory fallback — provider -> OAuth token row

const STATUSES   = ['Open', 'In Progress', 'Waiting for Release', 'Backlog', 'Resolved'];
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
const PLATFORMS  = ['iOS', 'Android'];

const clean = s => (typeof s === 'string' ? s.trim() : s);

// DB row (snake_case) <-> API shape (camelCase) the frontend already expects.
function toApi(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    priority: row.priority,
    status: row.status,
    areas: row.areas || [],
    platforms: row.platforms || [],
    affected: row.affected,
    date: row.date,
    images: row.images || [],
    tasks: row.tasks || [],
    userLinks: row.user_links || [],
    financeSupport: row.finance_support || false,
    reporterId: row.reporter_id || null,
    assigneeSlackId: row.assignee_slack_id || null,
    slackTs: row.slack_ts || null,
    slackChannel: row.slack_channel || null,
    slackUrl: row.slack_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function pgT(table, method, query, body, extraHeaders) {
  const resp = await fetch(`${restUrl(table)}${query}`, {
    method,
    headers: headers(extraHeaders),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new HttpError(502, (data && (data.message || data.error)) || `Storage error (${resp.status})`);
  return data;
}
// Incidents live in the `incidents` table.
const pg = (method, query, body, extraHeaders) => pgT('incidents', method, query, body, extraHeaders);

async function listIncidents() {
  if (!configured()) {
    const items = [...mem].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return { incidents: items };
  }
  const rows = await pg('GET', '?select=*&order=created_at.desc');
  return { incidents: (rows || []).map(toApi) };
}

// Best-effort: auto-create a dev bug task on the Delivery Sprint Board and post
// its link into the incident's Slack thread. Mutates api.tasks with the new
// link. Returns the task url (or null). Never throws — a Notion/Slack failure
// must not fail the incident. Lazy-requires notion to avoid a require cycle.
async function createBugTaskAndNotify(api, reporterName, assigneeId) {
  let taskUrl = null;
  try {
    const notion = require('./notion');
    const task = await notion.createBugTask(api, { reporterName, assigneeId });
    taskUrl = task && task.url ? task.url : null;
  } catch (e) { console.warn('createBugTask failed:', e && e.message); }
  if (taskUrl) {
    api.tasks = [...(api.tasks || []), taskUrl];
    try { await slackLib.postTaskCreated(api, taskUrl); } catch (_) {}
  }
  return taskUrl;
}

async function createIncident(body = {}, opts = {}) {
  const reporterId = opts.reporterId || null;
  const reporterName = opts.reporterName || null;
  const assigneeId = typeof body.assigneeId === 'string' ? body.assigneeId.trim() : '';
  const assigneeSlackId = typeof body.assigneeSlackId === 'string' ? body.assigneeSlackId.trim() : '';
  const title = clean(body.title);
  if (!title) throw new HttpError(400, 'Title is required');
  const now = new Date().toISOString();
  const id = 'inc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const row = {
    id,
    title,
    description: clean(body.description) || '',
    priority: PRIORITIES.includes(body.priority) ? body.priority : 'Medium',
    status: 'Open',
    areas: Array.isArray(body.areas) ? body.areas.filter(Boolean).slice(0, 12) : [],
    platforms: Array.isArray(body.platforms) ? body.platforms.filter(p => PLATFORMS.includes(p)) : [],
    affected: body.affected != null && body.affected !== '' ? Number(body.affected) : null,
    date: clean(body.date) || now.slice(0, 10),
    images: sanitizeImages(body.images),
    tasks: sanitizeTasks(body.tasks),
    user_links: sanitizeTasks(body.userLinks),
    finance_support: !!body.financeSupport,
    created_at: now,
    updated_at: now,
  };
  if (!configured()) {
    const api = toApi(row);
    mem.push(api);
    try { const s = await slackLib.postIncidentCreated(api, reporterId, assigneeSlackId); if (s) { api.slackTs = s.ts; api.slackChannel = s.channel; api.slackUrl = s.url || null; } } catch (_) {}
    await createBugTaskAndNotify(api, reporterName, assigneeId);
    return api;
  }
  const [inserted] = await pg('POST', '', row, { Prefer: 'return=representation' });
  const api = toApi(inserted);
  // Post the incident to Slack (best-effort) and remember the thread so later
  // status changes can reply in it. A Slack failure must not fail the incident.
  try {
    const s = await slackLib.postIncidentCreated(api, reporterId, assigneeSlackId);
    if (s) { api.slackTs = s.ts; api.slackChannel = s.channel; api.slackUrl = s.url || null; }
  } catch (_) {}
  // Auto-create the dev bug task and reply in the thread (best-effort). This
  // needs the Slack thread ts (set above), so it runs after the head message.
  await createBugTaskAndNotify(api, reporterName, assigneeId);
  api.reporterId = reporterId || null;
  api.assigneeSlackId = assigneeSlackId || null;
  // Persist reporter/assignee separately so a later status change can re-render
  // the head with those lines intact. Best-effort and isolated: if the columns
  // don't exist yet, this fails silently WITHOUT losing the Slack-thread patch
  // below (which would break threading).
  try { await pg('PATCH', `?id=eq.${encodeURIComponent(api.id)}`, { reporter_id: api.reporterId, assignee_slack_id: api.assigneeSlackId }); } catch (_) {}
  // Persist whatever we learned (Slack thread + auto-created task link).
  const patch = {};
  if (api.slackTs) { patch.slack_ts = api.slackTs; patch.slack_channel = api.slackChannel; patch.slack_url = api.slackUrl || null; }
  if (api.tasks && api.tasks.length) patch.tasks = api.tasks;
  if (Object.keys(patch).length) {
    try {
      const [upd] = await pg('PATCH', `?id=eq.${encodeURIComponent(api.id)}`, patch, { Prefer: 'return=representation' });
      if (upd) return toApi(upd);
    } catch (_) {}
  }
  return api;
}

// Keep at most a few small data-URL images per incident — Postgres/PostgREST
// handles this fine, but anything larger than a compressed screenshot is rejected
// to keep rows small and payloads fast.
const IMG_MAX_COUNT = 3;
const IMG_MAX_CHARS = 700_000; // ~500KB decoded
function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter(s => typeof s === 'string' && s.startsWith('data:image/') && s.length <= IMG_MAX_CHARS)
    .slice(0, IMG_MAX_COUNT);
}

// Links to the Notion task(s) that will resolve this incident — an incident
// can be reported before its fixing task exists, and gain links later via edit.
const TASK_MAX_COUNT = 10;
const TASK_MAX_CHARS = 2000;
function sanitizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter(s => typeof s === 'string' && s.length <= TASK_MAX_CHARS && /^https?:\/\//i.test(s.trim()))
    .map(s => s.trim())
    .slice(0, TASK_MAX_COUNT);
}

async function updateIncident(id, patch = {}) {
  if (!id) throw new HttpError(400, 'id is required');
  if (patch.status != null && !STATUSES.includes(patch.status)) throw new HttpError(400, 'Invalid status');
  const changes = { updated_at: new Date().toISOString() };
  if (patch.status != null)      changes.status = patch.status;
  if (patch.priority != null && PRIORITIES.includes(patch.priority)) changes.priority = patch.priority;
  if (patch.title != null)       changes.title = clean(patch.title);
  if (patch.description != null) changes.description = clean(patch.description);
  if (patch.tasks !== undefined) changes.tasks = sanitizeTasks(patch.tasks);
  if (patch.userLinks !== undefined) changes.user_links = sanitizeTasks(patch.userLinks);
  if (patch.areas !== undefined)     changes.areas = Array.isArray(patch.areas) ? patch.areas.filter(Boolean).slice(0, 12) : [];
  if (patch.platforms !== undefined) changes.platforms = Array.isArray(patch.platforms) ? patch.platforms.filter(p => PLATFORMS.includes(p)) : [];
  if (patch.affected !== undefined)  changes.affected = patch.affected != null && patch.affected !== '' ? Number(patch.affected) : null;
  if (patch.date != null)        changes.date = clean(patch.date);
  if (patch.images !== undefined)    changes.images = sanitizeImages(patch.images);
  if (patch.financeSupport !== undefined) changes.finance_support = !!patch.financeSupport;

  if (!configured()) {
    const inc = mem.find(x => x.id === id);
    if (!inc) throw new HttpError(404, 'Incident not found');
    const prevStatus = inc.status;
    if (changes.status != null)      inc.status = changes.status;
    if (changes.priority != null)    inc.priority = changes.priority;
    if (changes.title != null)       inc.title = changes.title;
    if (changes.description != null) inc.description = changes.description;
    if (changes.tasks != null)       inc.tasks = changes.tasks;
    if (changes.user_links != null)  inc.userLinks = changes.user_links;
    if (changes.areas != null)       inc.areas = changes.areas;
    if (changes.platforms != null)   inc.platforms = changes.platforms;
    if (changes.affected !== undefined) inc.affected = changes.affected;
    if (changes.date != null)        inc.date = changes.date;
    if (changes.images != null)      inc.images = changes.images;
    if (changes.finance_support !== undefined) inc.financeSupport = changes.finance_support;
    inc.updatedAt = changes.updated_at;
    if (changes.status != null && changes.status !== prevStatus) {
      try {
        await slackLib.postStatusChange(inc, changes.status);
        if (changes.status === 'Resolved')   await slackLib.setResolvedMark(inc, true);
        else if (prevStatus === 'Resolved')   await slackLib.setResolvedMark(inc, false);
      } catch (_) {}
    }
    try { await slackLib.updateIncidentHead(inc); } catch (_) {}
    return inc;
  }
  // Read the current status + Slack thread first so we can post a threaded
  // update only on an actual status change (not on every field edit).
  let existing = null;
  if (changes.status != null) {
    const rows = await pg('GET', `?id=eq.${encodeURIComponent(id)}&select=status,slack_ts,slack_channel&limit=1`);
    existing = rows && rows[0];
  }
  const [updated] = await pg('PATCH', `?id=eq.${encodeURIComponent(id)}`, changes, { Prefer: 'return=representation' });
  if (!updated) throw new HttpError(404, 'Incident not found');
  if (changes.status != null && existing && changes.status !== existing.status && existing.slack_ts) {
    try {
      await slackLib.postStatusChange(existing, changes.status);
      if (changes.status === 'Resolved')     await slackLib.setResolvedMark(existing, true);
      else if (existing.status === 'Resolved') await slackLib.setResolvedMark(existing, false);
    } catch (_) {}
  }
  // Re-render the head message so its Status (and other fields) stay current.
  try { await slackLib.updateIncidentHead(toApi(updated)); } catch (_) {}
  return toApi(updated);
}

async function deleteIncident(id) {
  if (!id) throw new HttpError(400, 'id is required');
  if (!configured()) {
    const i = mem.findIndex(x => x.id === id);
    if (i >= 0) mem.splice(i, 1);
    return { ok: true };
  }
  await pg('DELETE', `?id=eq.${encodeURIComponent(id)}`);
  return { ok: true };
}

// ── OAuth token storage ──────────────────────────────────────────────
// One row per provider in the `oauth_tokens` table (provider is the PK):
//   create table if not exists oauth_tokens (
//     provider text primary key,
//     access_token text not null, refresh_token text,
//     workspace_id text, workspace_name text, bot_id text,
//     updated_at timestamptz not null default now()
//   );
//   alter table oauth_tokens enable row level security;
// Falls back to an in-memory map when Supabase isn't configured (local dev).
async function getOAuthToken(provider = 'notion') {
  if (!configured()) return memTokens[provider] || null;
  const rows = await pgT('oauth_tokens', 'GET', `?provider=eq.${encodeURIComponent(provider)}&select=*&limit=1`);
  return (rows && rows[0]) || null;
}

async function saveOAuthToken(provider, tokens = {}) {
  const row = {
    provider,
    access_token:   tokens.access_token,
    refresh_token:  tokens.refresh_token || null,
    workspace_id:   tokens.workspace_id || null,
    workspace_name: tokens.workspace_name || null,
    bot_id:         tokens.bot_id || null,
    updated_at:     new Date().toISOString(),
  };
  if (!configured()) { memTokens[provider] = { ...(memTokens[provider] || {}), ...row }; return memTokens[provider]; }
  const [saved] = await pgT('oauth_tokens', 'POST', '', row, { Prefer: 'resolution=merge-duplicates,return=representation' });
  return saved;
}

// ── Release schedule ─────────────────────────────────────────────────
// One row per release cycle (keyed by the cycle's start date) that has been
// edited; unedited cycles fall back to cadence defaults computed on the
// frontend. Per-platform phase dates live in the ios/android jsonb columns.
//   create table if not exists releases (
//     cycle_key text primary key, cycle_num integer,
//     ios jsonb not null default '{}'::jsonb,
//     android jsonb not null default '{}'::jsonb,
//     updated_at timestamptz not null default now()
//   );
//   alter table releases enable row level security;
const memReleases = {};
const REL_FIELDS = ['freeze', 'devStart', 'devEnd', 'trStart', 'trEnd', 'publish'];
function sanitizeRel(obj) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const f of REL_FIELDS) {
      const v = obj[f];
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[f] = v;
    }
  }
  return out;
}
// A cycle holds a list of releases (0..n): 0 = sprint skipped, >1 = hotfixes
// etc. Each release has per-platform phase dates + a hard-update flag + label.
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 20).map(r => {
    r = r || {};
    // Hard-update is per platform; fall back to the legacy per-release bool.
    let hard = r.hard;
    if (!hard || typeof hard !== 'object') hard = { ios: !!r.hardUpdate, android: !!r.hardUpdate };
    return {
      label: typeof r.label === 'string' ? r.label.trim().slice(0, 80) : '',
      hard: { ios: !!hard.ios, android: !!hard.android },
      ios: sanitizeRel(r.ios),
      android: sanitizeRel(r.android),
    };
  });
}
function toReleaseApi(row) {
  let items = Array.isArray(row.items) ? row.items : null;
  if (!items) {
    // Backward compat: pre-multi-release rows stored a single ios/android.
    const ios = row.ios || {}, android = row.android || {};
    items = (Object.keys(ios).length || Object.keys(android).length)
      ? [{ label: '', hardUpdate: false, ios, android }] : [];
  }
  return { cycleKey: row.cycle_key, num: row.cycle_num, items };
}

async function listReleases() {
  if (!configured()) return { releases: Object.values(memReleases).map(toReleaseApi) };
  const rows = await pgT('releases', 'GET', '?select=*');
  return { releases: (rows || []).map(toReleaseApi) };
}

async function saveRelease(body = {}) {
  const key = body.cycleKey;
  if (!key) throw new HttpError(400, 'cycleKey is required');
  const row = {
    cycle_key: key,
    cycle_num: body.num != null && body.num !== '' ? Number(body.num) : null,
    items: sanitizeItems(body.items),
    updated_at: new Date().toISOString(),
  };
  if (!configured()) { memReleases[key] = row; return toReleaseApi(row); }
  const [saved] = await pgT('releases', 'POST', '', row, { Prefer: 'resolution=merge-duplicates,return=representation' });
  return toReleaseApi(saved);
}

module.exports = {
  listIncidents, createIncident, updateIncident, deleteIncident,
  getOAuthToken, saveOAuthToken,
  listReleases, saveRelease,
  STATUSES, PRIORITIES, HttpError, storageConfigured: configured,
};
