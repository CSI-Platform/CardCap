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
- `BETA_ACCESS_CODE`

Do not commit secret values. Local development secrets belong in `.dev.vars`, which is ignored by git.

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
