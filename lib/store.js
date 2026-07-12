// lib/store.js — persistence for incidents.
//
// Uses an Upstash Redis REST endpoint when configured (env vars are injected
// automatically by Vercel's Storage integration). Until that's set up — and for
// local dev — it falls back to an in-memory store so the app still runs
// (note: in-memory data is per-instance and NOT shared or persisted).

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const REST_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const configured = () => !!(REST_URL && REST_TOKEN);

const KEY = 'incidents';
const mem = {};   // { [key]: { [field]: value } } — fallback only

const STATUSES   = ['Open', 'In Progress', 'Backlog', 'Resolved'];
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

// Run one Redis command against the Upstash REST API.
async function cmd(args) {
  const resp = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) throw new HttpError(502, data.error || `Storage error (${resp.status})`);
  return data.result;
}

// Hash helpers — Redis when configured, in-memory otherwise.
async function hSet(field, val) {
  if (configured()) return cmd(['HSET', KEY, field, val]);
  (mem[KEY] = mem[KEY] || {})[field] = val; return 1;
}
async function hGet(field) {
  if (configured()) return cmd(['HGET', KEY, field]);
  return (mem[KEY] || {})[field] ?? null;
}
async function hDel(field) {
  if (configured()) return cmd(['HDEL', KEY, field]);
  if (mem[KEY]) delete mem[KEY][field]; return 1;
}
async function hGetAll() {
  if (configured()) return (await cmd(['HGETALL', KEY])) || [];
  const h = mem[KEY] || {}; return Object.entries(h).flatMap(([k, v]) => [k, v]);
}

const clean = s => (typeof s === 'string' ? s.trim() : s);

async function listIncidents() {
  const flat = await hGetAll();
  const items = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { items.push(JSON.parse(flat[i + 1])); } catch { /* skip malformed */ }
  }
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { incidents: items };
}

async function createIncident(body = {}) {
  const title = clean(body.title);
  if (!title) throw new HttpError(400, 'Title is required');
  const now = new Date().toISOString();
  const id = 'inc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const inc = {
    id,
    title,
    description: clean(body.description) || '',
    priority: PRIORITIES.includes(body.priority) ? body.priority : 'Medium',
    status: 'Open',
    areas: Array.isArray(body.areas) ? body.areas.filter(Boolean).slice(0, 12) : [],
    affected: body.affected != null && body.affected !== '' ? Number(body.affected) : null,
    date: clean(body.date) || now.slice(0, 10),
    createdAt: now,
    updatedAt: now,
  };
  await hSet(id, JSON.stringify(inc));
  return inc;
}

async function updateIncident(id, patch = {}) {
  if (!id) throw new HttpError(400, 'id is required');
  const cur = await hGet(id);
  if (!cur) throw new HttpError(404, 'Incident not found');
  const inc = JSON.parse(cur);
  if (patch.status != null) {
    if (!STATUSES.includes(patch.status)) throw new HttpError(400, 'Invalid status');
    inc.status = patch.status;
  }
  if (patch.priority != null && PRIORITIES.includes(patch.priority)) inc.priority = patch.priority;
  if (patch.title != null)       inc.title = clean(patch.title);
  if (patch.description != null) inc.description = clean(patch.description);
  inc.updatedAt = new Date().toISOString();
  await hSet(id, JSON.stringify(inc));
  return inc;
}

async function deleteIncident(id) {
  if (!id) throw new HttpError(400, 'id is required');
  await hDel(id);
  return { ok: true };
}

module.exports = {
  listIncidents, createIncident, updateIncident, deleteIncident,
  STATUSES, PRIORITIES, HttpError, storageConfigured: configured,
};
