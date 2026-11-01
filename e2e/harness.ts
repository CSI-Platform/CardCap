import { request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { ACCESS_AUDIENCE, ACCESS_HOSTS, ACCESS_ISSUER, JWKS_URL, defaultClaims, makeAccessKey, mintToken, type AccessKey, type MintOptions, type TokenClaims } from './access'
import { PNG_BYTES } from './fixtures'
import { FormData as MfFormData, Miniflare, Response as MfResponse } from 'miniflare'

const here = dirname(fileURLToPath(import.meta.url))

// Runs the real Worker (src/worker/index.ts) on local Miniflare with in-memory D1/R2.
// Outbound fetches (OpenAI, Resend) are intercepted: nothing leaves the machine and no paid AI call is made.

export const SESSION_SECRET = 'e2e-session-secret-not-real'
export const OPENAI_HOST = 'api.openai.com'
export const RESEND_HOST = 'api.resend.com'

export type OpenAiMode =
  | { kind: 'card'; card: Record<string, unknown> }
  | { kind: 'http-error'; status: number; body: string }
  | { kind: 'garbage' }

export type TraceEntry = { at: string; kind: 'request' | 'outbound'; method: string; url: string; status?: number; body?: string; note?: string }

export type HarnessOptions = {
  /** Turn on the Cloudflare Access simulator (AUTH_MODE=access with a test issuer, audience, hosts and JWKS). */
  access?: boolean
}

export type AccessSim = {
  keys: AccessKey[]
  jwksFetches: number
  /** Replace the published key set (e.g. to simulate rotation or an unknown kid). */
  publishKeys(keys: AccessKey[]): void
  token(email: string, overrides?: { claims?: TokenClaims; mint?: Partial<MintOptions>; sub?: string }): string
  /** Request as an Access-authenticated browser: signed JWT in both the header and the CF_Authorization cookie. */
  session(email: string, opts?: { sub?: string; host?: string }): Session
  /** Raw request with explicit credentials, for negative tests. */
  raw(path: string, init?: RequestInit & { headers?: Record<string, string> }, host?: string): Promise<Response>
}

export type Harness = {
  access: AccessSim
  mf: Miniflare
  openai: { mode: OpenAiMode; calls: number }
  trace: TraceEntry[]
  signIn(email: string): Promise<Session>
  anonymous(): Session
  r2Keys(): Promise<string[]>
  lastLoginLink(email: string): string | undefined
  dispose(): Promise<void>
}

export type Session = {
  email: string
  cookie: string
  request(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response>
}

export { PNG_BYTES }

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = process.env.CARDCAP_SRC ? resolve(process.env.CARDCAP_SRC) : resolve(here, '..')
  const outDir = mkdtempSync(join(tmpdir(), 'cardcap-e2e-'))
  const bundle = join(outDir, 'worker.mjs')
  await build({
    entryPoints: [join(root, 'src/worker/index.ts')],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker'],
    external: ['node:*', 'cloudflare:*'],
    logLevel: 'silent',
  })

  const trace: TraceEntry[] = []
  const openai = { mode: { kind: 'card', card: {} } as OpenAiMode, calls: 0 }
  const sentEmails: Array<{ to: string; text: string }> = []
  const accessKey = makeAccessKey('test-key-1')
  const access = { keys: [accessKey], published: [accessKey], jwksFetches: 0 }

  const mf = new Miniflare({
    modules: true,
    script: readFileSync(bundle, 'utf8'),
    scriptPath: 'worker.mjs',
    compatibilityDate: '2026-06-07',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'e2e-db' },
    r2Buckets: { CARD_IMAGES: 'e2e-images' },
    bindings: {
      SESSION_SECRET,
      AI_EXTRACTOR: 'openai',
      OPENAI_API_KEY: 'sk-test-not-real',
      OPENAI_MODEL: 'test-model',
      RESEND_API_KEY: 're_test_not_real',
      SENDER_EMAIL: 'test@example.invalid',
      ...(options.access
        ? { AUTH_MODE: 'access', ACCESS_ISSUER, ACCESS_AUDIENCE, ACCESS_ALLOWED_HOSTS: ACCESS_HOSTS.join(',') }
        : {}),
    },
    outboundService: async (request: Request) => {
      const url = new URL(request.url)
      const body = request.method === 'GET' ? '' : await request.text()
      if (url.hostname === RESEND_HOST) {
        const payload = JSON.parse(body) as { to: string[]; text: string }
        sentEmails.push({ to: payload.to[0], text: payload.text })
        trace.push({ at: new Date().toISOString(), kind: 'outbound', method: request.method, url: request.url, status: 200, note: 'resend intercepted' })
        return MfResponse.json({ id: 'email-test' })
      }
      if (request.url === JWKS_URL) {
        access.jwksFetches += 1
        trace.push({ at: new Date().toISOString(), kind: 'outbound', method: request.method, url: request.url, status: 200, note: 'access jwks intercepted' })
        return MfResponse.json({ keys: access.published.map((k) => k.jwk) })
      }
      if (url.hostname === OPENAI_HOST) {
        openai.calls += 1
        const mode = openai.mode
        trace.push({ at: new Date().toISOString(), kind: 'outbound', method: request.method, url: request.url, note: `openai intercepted (${mode.kind}); request body ${body.length} bytes` })
        if (mode.kind === 'http-error') return new MfResponse(mode.body, { status: mode.status })
        if (mode.kind === 'garbage') return MfResponse.json({ output_text: 'this is not json' })
        return MfResponse.json({ output_text: JSON.stringify(mode.card) })
      }
      trace.push({ at: new Date().toISOString(), kind: 'outbound', method: request.method, url: request.url, status: 599, note: 'UNEXPECTED outbound host blocked' })
      return new MfResponse('blocked by e2e harness', { status: 599 })
    },
  })
  const runtimeUrl = await mf.ready
  await applyMigrations(mf, root)

  const origin = 'https://cardcap.test'

  async function send(cookie: string, path: string, init: RequestInit & { headers?: Record<string, string> } = {}, host?: string): Promise<Response> {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('cookie', cookie)
    const res = options.access
      ? await rawHttp(runtimeUrl, path, init, headers, host || 'cardcap.test')
      : ((await mf.dispatchFetch(`${host ? `https://${host}` : origin}${path}`, { ...init, headers, redirect: 'manual' } as never)) as unknown as Response)
    let snippet = ''
    const type = res.headers.get('content-type') || ''
    if (/json|text/.test(type)) snippet = (await res.clone().text()).slice(0, 2000)
    trace.push({ at: new Date().toISOString(), kind: 'request', method: init.method || 'GET', url: path, status: res.status, body: snippet })
    return res
  }

  const accessSim: AccessSim = {
    get keys() {
      return access.keys
    },
    get jwksFetches() {
      return access.jwksFetches
    },
    publishKeys(keys) {
      access.published = keys
    },
    token(email, overrides = {}) {
      return mintToken({ key: accessKey, ...overrides.mint, claims: { ...defaultClaims(email, overrides.sub), ...overrides.claims } })
    },
    session(email, opts = {}) {
      const token = accessSim.token(email, { sub: opts.sub })
      const cookie = `CF_Authorization=${token}`
      return { email, cookie, request: (path, init) => send(cookie, path, { ...init, headers: { 'Cf-Access-Jwt-Assertion': token, ...init?.headers } }, opts.host) }
    },
    raw: (path, init, host) => send('', path, init, host),
  }

  return {
    access: accessSim,
    mf,
    openai,
    trace,
    anonymous: () => ({ email: '', cookie: '', request: (path, init) => send('', path, init) }),
    async signIn(email) {
      const before = sentEmails.length
      const res = await send('', '/api/auth/request-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (res.status !== 200 || sentEmails.length !== before + 1) throw new Error(`login link request failed: ${res.status}`)
      const link = sentEmails[sentEmails.length - 1].text.match(/https?:\/\/\S+\/api\/auth\/verify\?token=\w+/)?.[0]
      if (!link) throw new Error('no magic link in email')
      const verify = await send('', new URL(link).pathname + new URL(link).search)
      if (verify.status !== 302) throw new Error(`verify failed: ${verify.status}`)
      const cookie = (verify.headers.get('set-cookie') || '').split(';')[0]
      if (!cookie.startsWith('cardcap_session=')) throw new Error('no session cookie issued')
      return { email, cookie, request: (path, init) => send(cookie, path, init) }
    },
    lastLoginLink(email) {
      const mail = [...sentEmails].reverse().find((m) => m.to === email)
      return mail?.text.match(/https?:\/\/\S+\/api\/auth\/verify\?token=\w+/)?.[0]
    },
    async r2Keys() {
      const bucket = await mf.getR2Bucket('CARD_IMAGES')
      return (await bucket.list()).objects.map((o) => o.key).sort()
    },
    async dispose() {
      await mf.dispose()
    },
  }
}

export function saveTrace(name: string, trace: TraceEntry[], error?: unknown): void {
  const dir = resolve(here, '..', 'test-results', 'e2e-traces', process.env.CARDCAP_TARGET || 'worktree')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 100)}.json`)
  writeFileSync(file, JSON.stringify({ test: name, error: error ? String(error) : undefined, trace }, null, 2))
}

export function uploadForm(fileName: string, type = 'image/png', bytes: Uint8Array = PNG_BYTES): FormData {
  const form = new MfFormData() as unknown as FormData
  form.set('file', new Blob([bytes], { type }), fileName)
  return form
}

export function emptyForm(): FormData {
  return new MfFormData() as unknown as FormData
}

// Build the test database the way production is built: apply migrations/*.sql in order (not the Worker's runtime ensureSchema).
// D1 enforces the foreign keys these migrations declare, so ordering bugs surface here like they would in production.
async function applyMigrations(mf: Miniflare, root: string): Promise<void> {
  const dir = join(root, 'migrations')
  const db = await mf.getD1Database('DB')
  const files = readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort()
  if (files.length === 0) throw new Error(`no migrations found in ${dir}`)
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '')
    const statements = sql.split(/;\s*(?:\r?\n|$)/).map((stmt) => stmt.trim()).filter(Boolean)
    await db.batch(statements.map((stmt) => db.prepare(stmt)))
  }
}

// Miniflare's dispatchFetch keeps the requested URL but sends its own local address as the Host header, which a Worker
// that (rightly) compares the two would refuse. For Access tests we talk to the runtime over plain HTTP instead, with the
// Host header we choose, exactly as the Cloudflare edge would deliver it. An absolute request target lets a test send a
// Host header that disagrees with the URL.
async function rawHttp(runtimeUrl: URL, path: string, init: RequestInit, headers: Headers, host: string): Promise<Response> {
  let body: Buffer | undefined
  if (init.body instanceof MfFormData) {
    const encoded = new MfResponse(init.body as never)
    headers.set('content-type', encoded.headers.get('content-type') || '')
    body = Buffer.from(await encoded.arrayBuffer())
  } else if (typeof init.body === 'string') {
    body = Buffer.from(init.body)
  } else if (init.body instanceof Uint8Array) {
    body = Buffer.from(init.body)
  }
  headers.set('host', host)
  headers.set('connection', 'close')
  if (body) headers.set('content-length', String(body.length))
  const outgoing: Record<string, string> = {}
  headers.forEach((value, key) => {
    outgoing[key] = value
  })
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { hostname: runtimeUrl.hostname, port: runtimeUrl.port, path, method: init.method || 'GET', headers: outgoing, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v))
            else if (value !== undefined) responseHeaders.set(key, value)
          }
          const status = res.statusCode || 0
          const nullBody = status === 204 || status === 304
          resolvePromise(new Response(nullBody ? null : Buffer.concat(chunks), { status, headers: responseHeaders }))
        })
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
