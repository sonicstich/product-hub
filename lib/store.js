// lib/store.js — persistence for incidents.
//
// Talks to a Supabase Postgres table over its auto-generated PostgREST API
// (plain fetch, no @supabase/supabase-js dependency needed — same style as
// lib/notion.js). Until SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set — and
// for local dev without them — it falls back to an in-memory store so the
// app still runs (in-memory data is per-instance, NOT shared or persisted).

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = () => !!(SUPABASE_URL && SERVICE_KEY);
const TABLE_URL = () => `${SUPABASE_URL}/rest/v1/incidents`;
const headers = (extra = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

const mem = [];  // in-memory fallback — array of incident rows (camelCase, same shape as DB rows below)

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function pg(method, query, body, extraHeaders) {
  const resp = await fetch(`${TABLE_URL()}${query}`, {
    method,
    headers: headers(extraHeaders),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new HttpError(502, (data && (data.message || data.error)) || `Storage error (${resp.status})`);
  return data;
}

async function listIncidents() {
  if (!configured()) {
    const items = [...mem].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return { incidents: items };
  }
  const rows = await pg('GET', '?select=*&order=created_at.desc');
  return { incidents: (rows || []).map(toApi) };
}

async function createIncident(body = {}) {
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
    created_at: now,
    updated_at: now,
  };
  if (!configured()) { const api = toApi(row); mem.push(api); return api; }
  const [inserted] = await pg('POST', '', row, { Prefer: 'return=representation' });
  return toApi(inserted);
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
  if (patch.areas !== undefined)     changes.areas = Array.isArray(patch.areas) ? patch.areas.filter(Boolean).slice(0, 12) : [];
  if (patch.platforms !== undefined) changes.platforms = Array.isArray(patch.platforms) ? patch.platforms.filter(p => PLATFORMS.includes(p)) : [];
  if (patch.affected !== undefined)  changes.affected = patch.affected != null && patch.affected !== '' ? Number(patch.affected) : null;
  if (patch.date != null)        changes.date = clean(patch.date);
  if (patch.images !== undefined)    changes.images = sanitizeImages(patch.images);

  if (!configured()) {
    const inc = mem.find(x => x.id === id);
    if (!inc) throw new HttpError(404, 'Incident not found');
    if (changes.status != null)      inc.status = changes.status;
    if (changes.priority != null)    inc.priority = changes.priority;
    if (changes.title != null)       inc.title = changes.title;
    if (changes.description != null) inc.description = changes.description;
    if (changes.tasks != null)       inc.tasks = changes.tasks;
    if (changes.areas != null)       inc.areas = changes.areas;
    if (changes.platforms != null)   inc.platforms = changes.platforms;
    if (changes.affected !== undefined) inc.affected = changes.affected;
    if (changes.date != null)        inc.date = changes.date;
    if (changes.images != null)      inc.images = changes.images;
    inc.updatedAt = changes.updated_at;
    return inc;
  }
  const [updated] = await pg('PATCH', `?id=eq.${encodeURIComponent(id)}`, changes, { Prefer: 'return=representation' });
  if (!updated) throw new HttpError(404, 'Incident not found');
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

module.exports = {
  listIncidents, createIncident, updateIncident, deleteIncident,
  STATUSES, PRIORITIES, HttpError, storageConfigured: configured,
};
