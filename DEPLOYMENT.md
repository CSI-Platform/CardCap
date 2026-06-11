# CardCap Deployment

## Canonical Project Path

`C:\Users\codyl\Desktop\csiOS\Projects\CARDCAP`

Use this folder for future development, commits, and deploys. The earlier Codex `outputs\cardcap-app` folder is historical.

## Live Beta

- URL: `https://cardcap.codylecates.workers.dev`
- Worker name: `cardcap`
- D1 database: `cardcap-db`
- D1 database ID: `d3a74ece-fba4-4d92-a167-dfa21998c9ab`
- R2 bucket: `cardcap-card-images`

## Secrets

The Worker expects these secrets to be configured in Cloudflare:

- `OPENAI_API_KEY`
- `SESSION_SECRET` (32+ random characters; rotating it signs everyone out)
- `RESEND_API_KEY` (sender domain must be verified in Resend, DKIM green)
- `TURNSTILE_SECRET_KEY` (paired with the public `TURNSTILE_SITE_KEY` var in wrangler.jsonc)

`BETA_ACCESS_CODE` is retired and should be deleted from the Worker.

Do not commit secret values. Local development secrets belong in `.dev.vars`, which is ignored by git.

## First Deploy of Magic-Link Auth (one-time sequence)

1. Snapshot: `npx wrangler d1 export cardcap-db --remote --output backup-2026-06-09.sql`
2. Fresh start (wipes pre-auth beta data): `npx wrangler d1 execute cardcap-db --remote --command "DELETE FROM extraction_jobs; DELETE FROM contacts; DELETE FROM users;"`
3. Apply migrations: `npx wrangler d1 migrations apply cardcap-db --remote`
4. Create a Turnstile widget in the Cloudflare dashboard (Managed mode, hostname `cardcap.codylecates.workers.dev`); paste the site key into `TURNSTILE_SITE_KEY` in `wrangler.jsonc`, then `npx wrangler secret put TURNSTILE_SECRET_KEY`
5. `npx wrangler secret put SESSION_SECRET` and `npx wrangler secret put RESEND_API_KEY`
6. Confirm the `SENDER_EMAIL` var's address/domain is verified in Resend (currently `cody@copperstateit.com`; adjust the var if using a different sender)
7. `npx wrangler secret delete BETA_ACCESS_CODE`
8. `npm run build && npx wrangler deploy`
9. Smoke: `/api/health` returns `ok`; full sign-in round-trip from a phone; check a corporate-style inbox's spam folder for the link; upload one card and confirm `extractionMode: "openai"`; download the iContact CSV and test-import it into iContact.

## Local Development

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/`.

## Verification

```powershell
npm test
npm run lint
npm run build
```

The build script removes generated local env files from `dist/cardcap`.

## Deploy

```powershell
npx wrangler whoami
npm run build
npx wrangler deploy
```

If Cloudflare auth expires:

```powershell
npx wrangler login
```

## Production Smoke Test

After deployment, verify:

```powershell
Invoke-RestMethod -Uri 'https://cardcap.codylecates.workers.dev/api/health'
```

Expected: JSON with `ok: true` and `extractor: openai`.

For full upload testing, unlock with the beta session, upload a real card image, confirm `extractionMode` is `openai`, then delete the temporary contact.
