import { useEffect, useRef } from 'react'

type Props = {
  onConfirm: () => void
  onCancel: () => void
}

// Signing out through Cloudflare Access ends the person's sign-in for every CSI app that uses it, not just CardCap.
// Cloudflare documents that (and a 20 to 30 second delay), so this asks first and names Blackboard.
export function SignOutConfirm({ onConfirm, onCancel }: Props) {
  const stay = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    stay.current?.focus()
    const app = document.querySelector<HTMLElement>('.app-shell > .app-content')
    app?.setAttribute('inert', '')
    return () => app?.removeAttribute('inert')
  }, [])

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab' || !panel.current) return
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>('button'))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={panel}
        className="modal-panel session-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="signout-title"
        aria-describedby="signout-body"
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <div>
            <h2 id="signout-title">Sign out of CardCap and Blackboard?</h2>
          </div>
        </div>
        <div id="signout-body" className="session-body">
          <p>CardCap and Blackboard use the same CSI sign-in. Signing out here also signs you out of Blackboard and any other CSI app you have open.</p>
          <p>It can take up to 30 seconds to finish everywhere.</p>
        </div>
        <div className="modal-actions">
          <button ref={stay} className="btn primary" type="button" onClick={onCancel}>
            Stay signed in
          </button>
          <button className="btn" type="button" onClick={onConfirm}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
