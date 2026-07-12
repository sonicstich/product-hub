// lib/notion.js — shared Notion helpers.
// Used by BOTH the local Express server (server.js) and the Vercel
// serverless functions (api/*.js) so the logic never drifts between them.

const NOTION_DB_ID   = '102bba654d624b6bbd995720f8b245ba';
const NOTION_API     = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Error that carries an HTTP status code so callers can map it to a response.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function token() {
  return process.env.NOTION_TOKEN;
}

// Create a task page in the Notion database.
async function createTask(body) {
  if (!token()) {
    throw new HttpError(500, 'NOTION_TOKEN not configured. Set it in the host environment variables.');
  }

  const { title, why, metric, priority, criticalReason, dueDate, areas, otherAreaText, mockupLink, mockupFileNames } = body || {};
  if (!title?.trim()) throw new HttpError(400, 'Title is required');

  // Build the Why text, appending Other area + attached filenames if present
  let whyText = why?.trim() || '';
  if (otherAreaText)          whyText += `\n\nOther area: ${otherAreaText}`;
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

  const resp = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token()}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties: props }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new HttpError(resp.status, data.message || 'Notion error');
  return { ok: true, url: data.url, id: data.id };
}

// Query all tasks from the Notion database, sorted by due date.
async function listTasks() {
  if (!token()) throw new HttpError(500, 'NOTION_TOKEN not configured');

  const resp = await fetch(`${NOTION_API}/databases/${NOTION_DB_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token()}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sorts: [{ property: 'Due Date', direction: 'ascending' }],
      page_size: 100,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new HttpError(resp.status, data.message || 'Notion error');

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

module.exports = { createTask, listTasks, HttpError };
