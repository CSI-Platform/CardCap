// Serves the built SPA (dist/client) plus the real Worker on local Miniflare for browser tests.
// /__test/* are test-only controls; they are not part of the app.
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHarness } from '../harness'

const port = Number(process.env.PORT || 5199)
const dist = resolve(process.env.CARDCAP_DIST || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'client'))
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }

async function main() {
  const h = await startHarness()
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
        const out = (await h.mf.dispatchFetch(`https://cardcap.test${url.pathname}${url.search}`, {
          method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body, redirect: 'manual',
        } as never)) as unknown as Response
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
