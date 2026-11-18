# Deploy CardCap to Cloudflare

The Worker serves the React app and its API from one hostname. [cloudflare.config.ts](cloudflare.config.ts) defines the deployment target and bindings.

## Configure your environment

1. Install Node.js 24, run `npm ci`, and authenticate with `npx cf auth login`.
2. In the deployment configuration, set your Cloudflare account, Worker name, custom domain, and `PUBLIC_ORIGIN`. Use the HTTPS origin for the domain where users will open sign-in links.
3. Create a D1 database and R2 bucket in your account. Update the database ID and bucket name, enable Workers AI and Browser Run, and configure the rate-limit bindings for your Worker.
4. Verify a sending domain in Cloudflare Email Service. Set `SENDER_EMAIL` and the email binding’s allowed sender to the same address.
5. Configure a Turnstile widget for the app hostname. Set the public `TURNSTILE_SITE_KEY` in the configuration and store its paired `TURNSTILE_SECRET_KEY` and a randomly generated `SESSION_SECRET` as Worker secrets. Rotating the session secret signs users out.

## Migrate and deploy

Review the pending [D1 migrations](migrations/) against the intended database. Replace `DATABASE_ID` below with its ID. The apply command runs all pending migrations in the directory.

```sh
npm run deploy -- --dry-run
npx cf d1 migrations list DATABASE_ID
npx cf d1 migrations apply DATABASE_ID
npm run deploy
```

The deploy script builds the app and uploads it using the Cloudflare CLI. It expects the configured resources to exist.

## Verify the release

Check that `/api/health` returns `ok: true`. Sign in on the deployed hostname, capture a sample contact, and confirm its details in a CSV export.
