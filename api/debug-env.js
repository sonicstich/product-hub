// TEMPORARY diagnostic — reports env-var NAMES and lengths only (never values).
// Used to diagnose why NOTION_OAUTH_* aren't visible to the function. DELETE ME.
module.exports = (req, res) => {
  const names = Object.keys(process.env).filter(k => /NOTION|SUPABASE/i.test(k)).sort();
  res.status(200).json({
    matchingNames: names,
    hasNotionOauthClientId: 'NOTION_OAUTH_CLIENT_ID' in process.env,
    hasNotionOauthClientSecret: 'NOTION_OAUTH_CLIENT_SECRET' in process.env,
    clientIdLen: (process.env.NOTION_OAUTH_CLIENT_ID || '').length,
    clientSecretLen: (process.env.NOTION_OAUTH_CLIENT_SECRET || '').length,
    hasNotionToken: 'NOTION_TOKEN' in process.env,
  });
};
