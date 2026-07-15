// GET /api/notion-callback → exchange the OAuth authorization code for tokens
// and persist them (in Supabase). Shown after the user approves the consent
// screen; the redirect URI must match the one used by /api/notion-connect.
const notion = require('../lib/notion');

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (msg, ok) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notion connection</title>
<div style="font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:12vh auto;padding:0 24px;color:#1a1a1a">
  <div style="font-size:44px;margin-bottom:14px">${ok ? '✅' : '⚠️'}</div>
  <p style="margin:0">${msg}</p>
</div>`;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const q = req.query || {};
    if (q.error) {
      res.status(400).send(page(`Authorization was cancelled or failed: <b>${esc(q.error)}</b>.`, false));
      return;
    }
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host  = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${proto}://${host}/api/notion-callback`;
    const data = await notion.exchangeCode(q.code, redirectUri);
    res.status(200).send(page(`Connected to Notion workspace <b>${esc(data.workspace_name || '')}</b>. You can close this tab — <b>Create Task</b> now works.`, true));
  } catch (err) {
    res.status(err.status || 500).send(page(`Could not connect: ${esc(err.message)}`, false));
  }
};
