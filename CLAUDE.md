# Discord Product Robot

## Project
A Discord bot for Whiskey Library (a whiskey store). It automates product creation on Shopify and generates tasting cards.

## Stack
- **Runtime:** Node.js (ESM — all files use `import`/`export`, `"type": "module"` in package.json)
- **Bot framework:** discord.js v14
- **AI:** Google Gemini (`@google/generative-ai`), OpenAI
- **E-commerce:** Shopify Admin GraphQL API
- **Rendering:** Puppeteer (tasting card PNG generation)
- **Web server:** Express (serves tasting card HTML for Puppeteer)
- **Config:** All secrets via `process.env` (no dotenv — Railway injects env vars)

## File Layout
- `index.js` — Bot entry point, slash command routing
- `register-commands.js` — Registers Discord slash commands
- `pipeline.js` — Product creation pipeline (orchestrator)
- `ai.js` — AI integrations (Gemini, OpenAI)
- `shopify.js` — Shopify GraphQL API helpers
- `image.js` — Image processing
- `tasting-card.js` — Tasting card generation logic
- `tasting-card-server.js` — Express server for tasting card HTML
- `dev-command.js` — `/dev` command handler (triggers Claude dev agent)
- `search.js` — Search utilities

## Conventions
- ESM only — use `import`/`export`, never `require()`
- Config via `process.env` — no dotenv files
- Keep functions focused and files small
- Use `node-fetch` for HTTP requests (already a dependency)
- Discord slash commands defined in `register-commands.js`, handled in `index.js`
- Log threads: for long-running commands, create a Discord thread for status updates

## Environment Variables
Key env vars (set on Railway):
- `DISCORD_TOKEN`, `DISCORD_APP_ID` — Discord bot credentials
- `SHOPIFY_STORE`, `SHOPIFY_TOKEN` — Shopify API access
- `GEMINI_API_KEY` — Google Gemini
- `OPENAI_API_KEY` — OpenAI
- `GITHUB_PAT` — GitHub Personal Access Token (for /dev command)
