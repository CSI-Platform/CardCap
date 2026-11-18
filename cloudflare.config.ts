import { bindings, defineConfig } from 'cf/config'

export default defineConfig({
  accountId: '584b3d4e1cb07efb65c315c7efcce589',
  worker: {
    name: 'cardcap',
    entrypoint: './src/worker/index.ts',
    compatibilityDate: '2026-06-07',
    compatibilityFlags: ['nodejs_compat'],
    assets: {
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*'],
    },
    observability: { enabled: true, redactQueryString: true, headSamplingRate: 1 },
    env: {
      AI: bindings.ai({ dev: { remote: true } }),
      BROWSER: bindings.browser({ dev: { remote: true } }),
      AI_EXTRACTOR: bindings.text('cloudflare'),
      SENDER_EMAIL: bindings.text('cody@copperstateit.com'),
      TURNSTILE_SITE_KEY: bindings.text('0x4AAAAAADix1GoVxjHxnCXP'),
      RESEND_API_KEY: bindings.secret(),
      SESSION_SECRET: bindings.secret(),
      TURNSTILE_SECRET_KEY: bindings.secret(),
      // CF's D1 CLI reads ./migrations by default.
      DB: bindings.d1({ name: 'cardcap-db', id: 'd3a74ece-fba4-4d92-a167-dfa21998c9ab' }),
      CARD_IMAGES: bindings.r2({ name: 'cardcap-card-images' }),
      RL_LINK_EMAIL: bindings.rateLimit({ namespace: '1001', simple: { limit: 2, period: 60 } }),
      RL_LINK_IP: bindings.rateLimit({ namespace: '1002', simple: { limit: 5, period: 60 } }),
      RL_UPLOAD: bindings.rateLimit({ namespace: '1003', simple: { limit: 10, period: 60 } }),
      RL_PASSWORD_EMAIL: bindings.rateLimit({ namespace: '1004', simple: { limit: 2, period: 60 } }),
      RL_PASSWORD_IP: bindings.rateLimit({ namespace: '1005', simple: { limit: 5, period: 60 } }),
    },
  },
})
