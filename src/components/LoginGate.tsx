import { useEffect, useRef, useState } from 'react'
import { apiGet, apiJson } from '../lib/api'

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void },
      ) => string
      reset: (widgetId?: string) => void
    }
  }
}

type LoginGateProps = {
  onSignedIn: () => void
}

type LoginMode = 'password' | 'link'

export function LoginGate({ onSignedIn }: LoginGateProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<LoginMode>('password')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [siteKey, setSiteKey] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const widgetRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef('')

  useEffect(() => {
    let cancelled = false
    apiGet<{ turnstileSiteKey: string }>('/api/auth/config')
      .then((config) => {
        if (!cancelled) setSiteKey(config.turnstileSiteKey)
      })
      .catch(() => undefined)
    apiGet<{ email: string }>('/api/me')
      .then(() => {
        if (!cancelled) onSignedIn()
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (mode !== 'link') {
      widgetIdRef.current = ''
      return
    }
    if (!siteKey || !widgetRef.current || sent) return
    const renderWidget = () => {
      if (widgetRef.current && window.turnstile && !widgetIdRef.current) {
        widgetIdRef.current = window.turnstile.render(widgetRef.current, {
          sitekey: siteKey,
          callback: (token) => setTurnstileToken(token),
          'expired-callback': () => setTurnstileToken(''),
        })
      }
    }
    if (window.turnstile) {
      renderWidget()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
    script.async = true
    script.onload = renderWidget
    document.head.appendChild(script)
  }, [mode, sent, siteKey])

  async function signInWithPassword() {
    const trimmed = email.trim()
    if (!trimmed || !password) return
    setBusy(true)
    setError('')
    try {
      await apiJson<{ ok: boolean; email: string }>('/api/auth/password-login', 'POST', {
        email: trimmed,
        password,
      })
      onSignedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function requestLink() {
    const trimmed = email.trim()
    if (!trimmed) return
    setBusy(true)
    setError('')
    try {
      await apiJson<{ ok: boolean }>('/api/auth/request-link', 'POST', {
        email: trimmed,
        turnstileToken,
      })
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current)
        setTurnstileToken('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="unlock-screen">
      <section className="unlock-panel">
        <h2>Sign in to CardCap</h2>
        {mode === 'password' && (
          <>
            <label>
              Email
              <input
                type="email"
                value={email}
                autoComplete="email"
                placeholder="you@company.com"
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void signInWithPassword()
                }}
              />
            </label>
            <button
              className="btn primary"
              type="button"
              onClick={() => void signInWithPassword()}
              disabled={busy || !email.trim() || !password}
            >
              Sign in
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setMode('link')
                setError('')
                setTurnstileToken('')
                widgetIdRef.current = ''
              }}
              disabled={busy}
            >
              Use email link
            </button>
          </>
        )}
        {mode === 'link' && !sent && (
          <>
            <p>Enter your email and we&apos;ll send you a one-time sign-in link.</p>
            <label>
              Email
              <input
                type="email"
                value={email}
                autoComplete="email"
                placeholder="you@company.com"
                onChange={(event) => setEmail(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void requestLink()
                }}
              />
            </label>
            {siteKey && <div ref={widgetRef} className="turnstile-slot" />}
            <button
              className="btn primary"
              type="button"
              onClick={() => void requestLink()}
              disabled={busy || !email.trim() || (Boolean(siteKey) && !turnstileToken)}
            >
              Email me a sign-in link
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setMode('password')
                setError('')
                setTurnstileToken('')
                widgetIdRef.current = ''
              }}
              disabled={busy}
            >
              Use password
            </button>
          </>
        )}
        {mode === 'link' && sent && (
          <>
            <p>
              <strong>Check your email.</strong> We sent a sign-in link to {email.trim()}. It works once and expires in
              15 minutes.
            </p>
            <p>Don&apos;t see it? Check your spam or junk folder.</p>
            <button className="btn" type="button" onClick={() => void requestLink()} disabled={busy}>
              Send it again
            </button>
          </>
        )}
        {error && <div className="banner error">{error}</div>}
        <p className="privacy-note">Your contacts are private and yours — export or delete them anytime.</p>
      </section>
    </main>
  )
}
