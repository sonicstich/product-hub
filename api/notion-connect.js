// GET /api/notion-connect → send the user to Notion's OAuth consent screen.
// The redirect URI is derived from the incoming request host, so it works on
// any deployment domain (must be registered on the Notion connection too).
const notion = require('../lib/notion');

module.exports = (req, res) => {
  if (!notion.oauthConfigured()) {
    res.status(500).send('NOTION_OAUTH_CLIENT_ID / NOTION_OAUTH_CLIENT_SECRET are not set in this environment.');
    return;
  }
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/notion-callback`;
  res.writeHead(302, { Location: notion.authorizeUrl(redirectUri) });
  res.end();
};
