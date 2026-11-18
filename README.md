# CardCap

Phone-first business card capture for turning card photos into a searchable mini-CRM.

## What Works Now

- Open the app on desktop or phone-size browser.
- Sign in with a one-time email link (magic link); each user has a private contact list.
- Tap Add Cards to take a photo or upload card images.
- Store uploaded images in the local Cloudflare R2 binding.
- Store contacts in the local Cloudflare D1 database.
- Review the source card beside or above editable contact fields.
- Save searchable contacts with email, phone, website, map, notes, tags, status, and next step.
- Export CSV, vCard, JSON, standalone HTML, or an iContact-ready CSV for email-marketing imports.
- Extract card photos with Cloudflare Workers AI, or use mock photo extraction locally. Paste a signature, business details, or a website to review and save a contact.
- Abuse guards: Turnstile on sign-in, per-minute rate limits, and a 25-cards/day extraction quota per user.

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
npm run deploy -- --dry-run
```

## Cloudflare extraction in development

Sign in with `npx cf auth login`. The Worker uses the remote AI binding for photo and text extraction and the Browser Run binding for website lookup. Set `AI_EXTRACTOR=cloudflare` in `.dev.vars` for live photo extraction or `AI_EXTRACTOR=mock` for local photo fixtures.

## Auth in Local Dev

- Leave `SESSION_SECRET` unset in `.dev.vars` to auto-sign-in as the local user (no email needed).
- Set `SESSION_SECRET` to any 32+ character string to exercise the real magic-link flow. Sign-in links use the Cloudflare EMAIL binding.
- `TURNSTILE_SECRET_KEY` unset means the Turnstile check is skipped locally.

## Production deployment

The `cardcap` Cloudflare Worker serves the app and API. Its production bindings are defined in `cloudflare.config.ts`. Contacts use D1 and photos use R2. The D1 CLI uses the existing `./migrations` directory.

```powershell
npm run deploy -- --dry-run
npm run deploy
```
