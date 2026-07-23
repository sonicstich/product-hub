// lib/slack.js — post incident notifications to Slack via chat.postMessage.
//
// Best-effort by design: the caller wraps these in try/catch so a Slack
// failure NEVER blocks creating or updating an incident. Requires a bot
// token (SLACK_BOT_TOKEN, xoxb-…) with chat:write, and SLACK_CHANNEL_ID.

const SLACK_API = 'https://slack.com/api';
const TOKEN   = () => process.env.SLACK_BOT_TOKEN;
const CHANNEL = () => process.env.SLACK_CHANNEL_ID;
const APP_URL = () => process.env.APP_BASE_URL || 'https://product-hub-cusp.vercel.app';
const slackConfigured = () => !!(TOKEN() && CHANNEL());

async function call(method, body) {
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  if (!data || !data.ok) throw new Error(`Slack ${method} failed: ${(data && data.error) || resp.status}`);
  return data;
}

// Resolve the public permalink for a message (correct workspace domain, no
// hardcoding). Returns null on failure — callers treat it as best-effort.
async function permalink(channel, ts) {
  const resp = await fetch(`${SLACK_API}/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(ts)}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });
  const data = await resp.json().catch(() => null);
  return data && data.ok ? data.permalink : null;
}

const SEV_EMOJI    = { Critical: '🔴', High: '🟠', Medium: '🟡', Low: '⚪️' };
const STATUS_EMOJI = { 'Open': '🆕', 'In Progress': '🛠️', 'Waiting for Release': '🚀', 'Backlog': '📋', 'Resolved': '✅' };

// Who to @mention for an incident, based on its "Related to" areas.
// INCIDENT_ASSIGNEES is a JSON map of area → Slack member id, plus a
// "default" fallback, e.g. {"default":"U123","Trading":"U456","KYC":"U789"}.
// Returns the de-duplicated list of member ids to tag (falls back to default
// when no area matches).
function assigneeMap() {
  try { return JSON.parse(process.env.INCIDENT_ASSIGNEES || '{}'); } catch (_) { return {}; }
}
function assigneesFor(areas) {
  const map = assigneeMap();
  const ids = new Set();
  const add = v => { if (Array.isArray(v)) v.forEach(x => x && ids.add(x)); else if (v) ids.add(v); };
  const arr = Array.isArray(areas) ? areas : [];
  if (!arr.length) { add(map.default); return [...ids]; }
  arr.forEach(a => add(map[a] != null ? map[a] : map.default));
  return [...ids];
}
function mentions(ids) { return ids.map(id => `<@${id}>`).join(' '); }

// Post the head message for a new incident. `reporterId` (optional) is the
// Slack id of whoever reported it (from Slack sign-in) — tagged too.
// Returns { ts, channel, url } or null.
async function postIncidentCreated(inc, reporterId, assigneeSlackId) {
  if (!slackConfigured()) return null;
  const title = (inc.title || 'Untitled incident').slice(0, 150);
  const desc  = (inc.description || '').slice(0, 2900) || '_No description_';
  const fields = [
    { type: 'mrkdwn', text: `*Severity:*\n${SEV_EMOJI[inc.priority] || ''} ${inc.priority || '—'}` },
    { type: 'mrkdwn', text: `*Status:*\n${STATUS_EMOJI[inc.status] || ''} ${inc.status || '—'}` },
  ];
  if (inc.areas && inc.areas.length)         fields.push({ type: 'mrkdwn', text: `*Area:*\n${inc.areas.join(', ')}` });
  if (inc.platforms && inc.platforms.length) fields.push({ type: 'mrkdwn', text: `*Platform:*\n${inc.platforms.join(', ')}` });
  if (inc.affected != null)                  fields.push({ type: 'mrkdwn', text: `*Affected users:*\n${inc.affected}` });
  fields.push({ type: 'mrkdwn', text: `*Finance support:*\n${inc.financeSupport ? '💰 Yes' : 'Not needed'}` });

  // An explicit assignee picked in the form wins; otherwise fall back to the
  // area→assignee map (INCIDENT_ASSIGNEES).
  const owners = (assigneeSlackId ? [assigneeSlackId] : assigneesFor(inc.areas)).filter(Boolean);
  const financeId = inc.financeSupport ? (process.env.FINANCE_SLACK_ID || 'U0B8SGXTG7P') : null;
  const peopleLines = [];
  if (reporterId)    peopleLines.push(`*Reported by:* <@${reporterId}>`);
  if (owners.length) peopleLines.push(`*Assignee:* ${mentions(owners)}`);
  if (financeId)     peopleLines.push(`*Finance team:* <@${financeId}>`);

  const blocks = [
    { type: 'header',  text: { type: 'plain_text', text: `🐛 ${title}`.slice(0, 150), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: desc } },
    { type: 'section', fields },
  ];
  if (peopleLines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: peopleLines.join('\n') } });

  // Admin-panel links for the affected user(s), if any were provided.
  const userLinks = Array.isArray(inc.userLinks) ? inc.userLinks.slice(0, 10) : [];
  if (userLinks.length) {
    const label = userLinks.length > 1 ? 'Affected users in admin' : 'Affected user in admin';
    const links = userLinks.map((u, i) => `<${u}|User ${i + 1}>`).join('   ');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${label}:*\n${links}` } });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${APP_URL()}/#incidents|Open in Product Hub>` }] });

  // Mentions in the notification text so the tagged people actually get pinged.
  const pingIds = [...new Set([...(reporterId ? [reporterId] : []), ...owners, ...(financeId ? [financeId] : [])])];
  const data = await call('chat.postMessage', {
    channel: CHANNEL(),
    text: `🐛 New incident: ${title}${pingIds.length ? ' ' + mentions(pingIds) : ''}`,
    unfurl_links: false,
    blocks,
  });
  let url = null;
  try { url = await permalink(data.channel, data.ts); } catch (_) {}
  return { ts: data.ts, channel: data.channel, url };
}

// Reply in the incident's thread when its status changes. No-op if we never
// posted a head message for this incident (no thread to reply to).
async function postStatusChange(inc, newStatus) {
  const ts = inc && (inc.slack_ts || inc.slackTs);
  const ch = (inc && (inc.slack_channel || inc.slackChannel)) || CHANNEL();
  if (!slackConfigured() || !ts) return null;
  await call('chat.postMessage', {
    channel: ch,
    thread_ts: ts,
    text: `${STATUS_EMOJI[newStatus] || '🔄'} Status → *${newStatus}*`,
  });
  return true;
}

// Reply in the incident's thread with the link to the dev task we auto-created
// on the Delivery Sprint Board. No-op if there's no thread or no task url.
async function postTaskCreated(inc, taskUrl) {
  const ts = inc && (inc.slack_ts || inc.slackTs);
  const ch = (inc && (inc.slack_channel || inc.slackChannel)) || CHANNEL();
  if (!slackConfigured() || !ts || !taskUrl) return null;
  await call('chat.postMessage', {
    channel: ch,
    thread_ts: ts,
    unfurl_links: false,
    text: `📝 Dev task created on the Delivery Sprint Board → <${taskUrl}|Open task>`,
  });
  return true;
}

// Add (or remove) a ✅ reaction on the incident's head message so a resolved
// incident is visible at a glance in the channel. Needs the reactions:write
// scope. reactions.add on an already-reacted message (or remove on a missing
// one) errors harmlessly — the caller swallows it.
async function setResolvedMark(inc, resolved) {
  const ts = inc && (inc.slack_ts || inc.slackTs);
  const ch = (inc && (inc.slack_channel || inc.slackChannel)) || CHANNEL();
  if (!slackConfigured() || !ts) return null;
  await call(resolved ? 'reactions.add' : 'reactions.remove', {
    channel: ch,
    timestamp: ts,
    name: 'white_check_mark',
  });
  return true;
}

module.exports = { slackConfigured, postIncidentCreated, postStatusChange, setResolvedMark, postTaskCreated };
