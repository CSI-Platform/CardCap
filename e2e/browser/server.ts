// Serves the built SPA (dist/client) plus the real Worker on local Miniflare for browser tests.
// /__test/* are test-only controls; they are not part of the app.
// With ACCESS_SIM=1 the Worker runs in AUTH_MODE=access behind a SIMULATED Cloudflare Access edge: nothing is served without
// a simulated session cookie, unauthenticated requests (pages and API calls alike) are redirected to a fake sign-in page,
// and signed-in requests reach the Worker with a signed Access JWT. This imitates the edge; it is not live Access.
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHarness } from '../harness'

const port = Number(process.env.PORT || 5199)
const dist = resolve(process.env.CARDCAP_DIST || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'client'))
const accessSim = process.env.ACCESS_SIM === '1'
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }

async function main() {
  const h = await startHarness({ access: accessSim })
  let epoch = 1 // bumping this ends every simulated session at once
  const simCookie = (req: { headers: { cookie?: string } }) => /(?:^|;\s*)sim_access=([^;]+)/.exec(req.headers.cookie || '')?.[1]
  const simEmail = (req: { headers: { cookie?: string } }) => {
    const [email, seen] = decodeURIComponent(simCookie(req) || '').split('|')
    return email && Number(seen) === epoch ? email : ''
  }
  h.openai.mode = {
    kind: 'card',
    card: {
      name: 'Maria Okafor', company: 'Sunrise Realty Group', role: 'Broker', emails: ['maria@sunrise.example'],
      phones: ['(602) 555-0142'], website: 'sunrise.example', address: '12 Main St, Phoenix, AZ',
      tags: ['Luxury'], notes: 'Met at expo', confidence: 0.62, needs_review: true,
    },
  }

  createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
      if (accessSim && !url.pathname.startsWith('/__test/')) {
        if (url.pathname === '/sim-idp') {
          if (req.method === 'POST') {
            const form = new URLSearchParams(Buffer.concat(await collect(req)).toString())
            const email = (form.get('email') || '').trim()
            const back = form.get('return') || '/'
            res.writeHead(302, { location: back.startsWith('/') && !back.startsWith('//') ? back : '/', 'set-cookie': `sim_access=${encodeURIComponent(`${email}|${epoch}`)}; Path=/; HttpOnly` }).end()
            return
          }
          const back = url.searchParams.get('return') || '/'
          res
            .writeHead(200, { 'content-type': 'text/html' })
            .end(`<!doctype html><html lang="en"><title>Simulated sign-in</title><main><h1>Simulated Access sign-in</h1><form method="post" action="/sim-idp"><label>Email <input name="email" type="email" required></label><input type="hidden" name="return" value="${back.replace(/"/g, '')}"><button>Continue</button></form></main>`)
          return
        }
        if (url.pathname === '/cdn-cgi/access/logout') {
          res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sim_access=; Path=/; Max-Age=0' }).end('<!doctype html><html lang="en"><title>Signed out</title><h1>You are signed out</h1>')
          return
        }
        if (url.pathname === '/cdn-cgi/access/login') {
          res.writeHead(302, { location: `/sim-idp?return=${encodeURIComponent(url.searchParams.get('redirect_url') || '/')}` }).end()
          return
        }
        if (!simEmail(req)) {
          res.writeHead(302, { location: `/sim-idp?return=${encodeURIComponent(url.pathname + url.search)}` }).end()
          return
        }
      }
      if (url.pathname === '/__test/login-link') {
        const link = h.lastLoginLink(url.searchParams.get('email') || '')
        res.writeHead(link ? 200 : 404, { 'content-type': 'text/plain' }).end(link ? new URL(link).pathname + new URL(link).search : '')
        return
      }
      if (url.pathname === '/__test/openai') {
        const kind = url.searchParams.get('mode')
        if (kind === 'error') h.openai.mode = { kind: 'http-error', status: 500, body: 'upstream-internal-detail-abc123' }
        else if (kind === 'garbage') h.openai.mode = { kind: 'garbage' }
        else h.openai.mode = { kind: 'card', card: { name: 'Maria Okafor', company: 'Sunrise Realty Group', role: 'Broker', emails: ['maria@sunrise.example'], phones: ['(602) 555-0142'], website: 'sunrise.example', address: '12 Main St, Phoenix, AZ', tags: ['Luxury'], notes: 'Met at expo', confidence: 0.62, needs_review: true } }
        res.writeHead(200).end('ok')
        return
      }
      if (url.pathname === '/__test/seed-duplicate-email') {
        const email = url.searchParams.get('email') || ''
        const db = await h.mf.getD1Database('DB')
        for (const id of ['dup-a', 'dup-b']) {
          await db.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, 't', 't')").bind(`${id}-${email}`, email, email).run()
        }
        res.writeHead(200).end('ok')
        return
      }
      if (url.pathname === '/__test/access-expire') {
        epoch += 1
        res.writeHead(200).end('ok')
        return
      }
      if (url.pathname === '/__test/r2') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await h.r2Keys()))
        return
      }
      if (url.pathname.startsWith('/api/')) {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) if (v && k !== 'host' && k !== 'connection') headers.set(k, Array.isArray(v) ? v.join(', ') : v)
        const body = chunks.length ? Buffer.concat(chunks) : undefined
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
        const out = accessSim
          ? await h.access.raw(
              `${url.pathname}${url.search}`,
              { method: req.method, headers: { ...Object.fromEntries(headers), 'Cf-Access-Jwt-Assertion': h.access.token(simEmail(req)) }, body: hasBody ? body : undefined } as never,
              'cardcap.test',
            )
          : ((await h.mf.dispatchFetch(`https://cardcap.test${url.pathname}${url.search}`, {
              method: req.method, headers, body: hasBody ? body : undefined, redirect: 'manual',
            } as never)) as unknown as Response)
        const outHeaders: Record<string, string | string[]> = {}
        out.headers.forEach((v, k) => { if (k !== 'set-cookie') outHeaders[k] = v })
        const cookies = (out.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() || []
        // Local http: drop Secure so the browser accepts the session cookie.
        if (cookies.length) outHeaders['set-cookie'] = cookies.map((c) => c.replace(/;\s*Secure/i, ''))
        res.writeHead(out.status, outHeaders).end(Buffer.from(await out.arrayBuffer()))
        return
      }
      let file = join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
      if (!file.startsWith(dist) || !existsSync(file)) file = join(dist, 'index.html')
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(readFileSync(file))
    } catch (error) {
      res.writeHead(500).end(String(error))
    }
  }).listen(port, '127.0.0.1', () => console.log(`cardcap e2e server on http://127.0.0.1:${port}`))
}

void main()

async function collect(req: AsyncIterable<Buffer | string>): Promise<Buffer[]> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return chunks
}
