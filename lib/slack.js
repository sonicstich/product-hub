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

const SEV_EMOJI    = { Critical: '🔴', High: '🟠', Medium: '🟡', Low: '⚪️' };
const STATUS_EMOJI = { 'Open': '🆕', 'In Progress': '🛠️', 'Waiting for Release': '🚀', 'Backlog': '📋', 'Resolved': '✅' };

// Post the head message for a new incident. Returns { ts, channel } or null.
async function postIncidentCreated(inc) {
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

  const data = await call('chat.postMessage', {
    channel: CHANNEL(),
    text: `🐛 New incident: ${title}`, // notification fallback / accessibility
    unfurl_links: false,
    blocks: [
      { type: 'header',  text: { type: 'plain_text', text: `🐛 ${title}`.slice(0, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: desc } },
      { type: 'section', fields },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `<${APP_URL()}/#incidents|Open in Product Hub>` }] },
    ],
  });
  return { ts: data.ts, channel: data.channel };
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

module.exports = { slackConfigured, postIncidentCreated, postStatusChange };
