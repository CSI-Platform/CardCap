# Local development

Use Node.js 24 and npm. From the repository root, install dependencies and run the unit tests.

```sh
npm ci
npm test
```

## Run the app

For interactive development, configure your own Cloudflare resources and sender as described in the [deployment guide](../DEPLOYMENT.md). Copy [.dev.vars.example](../.dev.vars.example) to `.dev.vars` and set a local `SESSION_SECRET` for sign-in. Use a Turnstile site key and secret appropriate to your development hostname when testing email links.

```sh
npx cf auth login
npm run dev -- --host 127.0.0.1
```

Open the local address printed by Vite. Set `AI_EXTRACTOR=mock` for fixture-based photo extraction. Pasted text and website lookup use remote Cloudflare bindings.

## Verify changes

```sh
npm run lint
npm run build
npm run test:e2e
```

For a browser walkthrough without a production account, run the Playwright suites. They launch a local test server with disposable data and simulated email delivery.

```sh
npx playwright install chromium
npm run test:browser
npm run test:browser:access
```

The [GitHub Actions workflow](../.github/workflows/checks.yml) lists the full set of release checks.
