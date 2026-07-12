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

### Required environment variable

Set in **Vercel → Project → Settings → Environment Variables**:

| Name           | Value                        | Environments            |
| -------------- | ---------------------------- | ----------------------- |
| `NOTION_TOKEN` | your Notion integration secret | Production, Preview, Dev |

After changing env vars, redeploy for them to take effect.
