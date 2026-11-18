import { useEffect, useRef, useState } from 'react'
import { apiGet } from '../lib/api'
import type { DashboardActivity } from '../shared/types'

type Props = {
  contacts: number
  review: number
  busy: boolean
  capturing: boolean
  input: string
  onInput: (value: string) => void
  onCapture: () => void
  onUpload: () => void
}

const stateLabels = { complete: 'Complete', failed: 'Failed', processing: 'Processing' }

export function Dashboard({ contacts, review, busy, capturing, input, onInput, onCapture, onUpload }: Props) {
  const [activity, setActivity] = useState<DashboardActivity | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [mode, setMode] = useState<'domain' | 'signature' | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      let delay = 30000
      try {
        const result = await apiGet<DashboardActivity>('/api/import-activity')
        if (cancelled) return
        setActivity(result)
        setUnavailable(false)
        if (busy || result.processing) delay = 2000
      } catch {
        if (cancelled) return
        setUnavailable(true)
      }
      timer = setTimeout(refresh, delay)
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [busy])

  function openCapture(next: 'domain' | 'signature') {
    setMode(next)
    requestAnimationFrame(() => field.current?.focus())
  }

  return (
    <section className="dashboard" aria-labelledby="dashboard-title">
      <h2 id="dashboard-title">Dashboard</h2>
      <dl className="dashboard-totals">
        <div><dt>Detected contacts</dt><dd>{contacts}</dd></div>
        <div><dt>Needs review</dt><dd>{review}</dd></div>
        <div><dt>Processing now</dt><dd>{unavailable ? '—' : activity?.processing ?? '…'}</dd></div>
        <div><dt>Errors in 24 hours</dt><dd>{unavailable ? '—' : activity?.errors ?? '…'}</dd></div>
      </dl>
      <div className="dashboard-sections">
        <section aria-labelledby="quick-actions">
          <h3 id="quick-actions">Quick actions</h3>
          <div className="dashboard-actions">
            <button className="btn" disabled={busy} onClick={() => openCapture('domain')}>Add a domain</button>
            <button className="btn" disabled={busy} onClick={onUpload}>Upload business cards</button>
            <button className="btn" disabled={busy} onClick={() => openCapture('signature')}>Paste an email signature</button>
          </div>
          {(mode || input) && <form className="capture-form" onSubmit={event => { event.preventDefault(); onCapture() }}>
            <label htmlFor="contact-capture">{mode === 'domain' ? 'Website domain' : 'Signature or business details'}</label>
            <textarea ref={field} id="contact-capture" value={input} maxLength={12000} rows={mode === 'domain' ? 2 : 4}
              disabled={busy} placeholder={mode === 'domain' ? 'example.com' : 'Paste contact details'} onChange={event => onInput(event.currentTarget.value)} />
            <button className="btn" disabled={busy || !input.trim()}>{capturing ? 'Finding contact details…' : 'Review contact'}</button>
          </form>}
        </section>
        <section aria-labelledby="recent-imports">
          <h3 id="recent-imports">Recent imports</h3>
          {unavailable && <p>Import activity is unavailable. Reconnecting…</p>}
          {!activity && !unavailable && <p>Loading import activity…</p>}
          {activity && !activity.recent.length && !unavailable && <p>No imports yet.</p>}
          {!!activity?.recent.length && <ul className="import-list">{activity.recent.map(item => (
            <li key={item.id}>
              <div><strong>{item.label}</strong><span>{item.detail || 'Processing…'}</span></div>
              <div><b className={'import-' + item.state}>{stateLabels[item.state]}</b>
                <time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div>
            </li>
          ))}</ul>}
        </section>
      </div>
    </section>
  )
}
