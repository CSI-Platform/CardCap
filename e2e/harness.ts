import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
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

export type Harness = {
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

export async function startHarness(): Promise<Harness> {
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
  await mf.ready

  const origin = 'https://cardcap.test'

  async function send(cookie: string, path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('cookie', cookie)
    const res = (await mf.dispatchFetch(`${origin}${path}`, { ...init, headers, redirect: 'manual' } as never)) as unknown as Response
    let snippet = ''
    const type = res.headers.get('content-type') || ''
    if (/json|text/.test(type)) snippet = (await res.clone().text()).slice(0, 2000)
    trace.push({ at: new Date().toISOString(), kind: 'request', method: init.method || 'GET', url: path, status: res.status, body: snippet })
    return res
  }

  return {
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
