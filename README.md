# CardCap

Phone-first business card capture for turning card photos into a searchable mini-CRM.

## What Works Now

- Open the app on desktop or phone-size browser.
- Tap Add Cards to take a photo or upload card images.
- Store uploaded images in the local Cloudflare R2 binding.
- Store contacts in the local Cloudflare D1 database.
- Review the source card beside or above editable contact fields.
- Save searchable contacts with email, phone, website, map, notes, tags, status, and next step.
- Export CSV, vCard, JSON, or standalone HTML.
- Run AI extraction in mock mode locally, or switch to OpenAI with an API key.

## Local Development

```powershell
npm install
npm run dev -- --host 127.0.0.1
```

Then open:

```text
http://127.0.0.1:5173/
```

Health check:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5173/api/health
```

## Verification

```powershell
npm run lint
npm test
npm run build
npx wrangler deploy --dry-run
```

## Turn On OpenAI Extraction Locally

Copy `.dev.vars.example` to `.dev.vars`, then set:

```text
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5-mini
AI_EXTRACTOR=openai
```

Restart the dev server after changing `.dev.vars`.

## Cloudflare Setup Later

Cloudflare can host the frontend, Worker API, database, and image storage for this version. No Supabase is needed for the first SaaS cut.

When you are ready to deploy:

```powershell
npx wrangler login
npx wrangler d1 create cardcap-local
npx wrangler r2 bucket create cardcap-card-images
npx wrangler d1 migrations apply cardcap-local --remote
npx wrangler secret put OPENAI_API_KEY
```

After `d1 create`, replace the placeholder `database_id` in `wrangler.jsonc`. For production AI extraction, change `AI_EXTRACTOR` from `mock` to `openai` in `wrangler.jsonc`, then deploy:

```powershell
npm run build
npx wrangler deploy
```

## Current Production Gaps

- Auth is not wired yet. The Worker uses one local user record so the capture flow can be built and tested first.
- Production D1 and R2 resources have not been created yet.
- OpenAI extraction is wired but not enabled until `OPENAI_API_KEY` is provided and `AI_EXTRACTOR=openai`.
