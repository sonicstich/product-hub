# CUSP Product Hub

Team's central hub — release calendar, incident reporting, task creation (synced to Notion),
and quick links to Metabase, Amplitude, and documentation.

## Architecture

- **`public/index.html`** — the entire single-file front-end (SPA).
- **`api/*.js`** — Vercel serverless functions that proxy to the Notion API
  (they keep `NOTION_TOKEN` server-side, never exposed to the browser).
- **`lib/notion.js`** — shared Notion logic used by both the API functions and the local server.
- **`server.js`** — local dev server (Express) that reproduces the Vercel routing.

## Local development

```bash
npm install
cp .env.example .env      # then paste your real NOTION_TOKEN
npm run dev               # → http://localhost:8080/
```

Without `NOTION_TOKEN` the site works, but the **Create Task** form can't write to Notion.

## Deployment (Vercel)

This repo is connected to Vercel with Git integration:

1. Every push to `main` triggers an automatic production deploy.
2. Pull requests get their own preview deploys.

### Notion authentication (two options)

Set in **Vercel → Project → Settings → Environment Variables**, then redeploy.

**Option A — static token** (simplest, but the workspace-scoped "Access token"
is often admin-restricted):

| Name           | Value                          |
| -------------- | ------------------------------ |
| `NOTION_TOKEN` | your Notion integration secret |

**Option B — OAuth** (any member can create an OAuth connection; use this when
you can't get a static token). Create an OAuth connection at
notion.so/profile/integrations with Redirect URI
`https://<your-domain>/api/notion-callback`, then set:

| Name                         | Value                         |
| ---------------------------- | ----------------------------- |
| `NOTION_OAUTH_CLIENT_ID`     | OAuth connection Client ID    |
| `NOTION_OAUTH_CLIENT_SECRET` | OAuth connection Client secret |

Then visit `/api/notion-connect` once to authorize. Tokens are stored in
Supabase (`oauth_tokens` table) and auto-refreshed; if a refresh ever fails,
the Create Task form shows a **Connect Notion** link to re-authorize.
Requires the same `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` used for incidents.
