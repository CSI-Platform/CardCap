import { useEffect, useRef } from 'react'

export type SessionProblem =
  | { kind: 'ended'; hasUnsavedEdits: boolean }
  | { kind: 'denied'; message: string; logoutUrl?: string }

type Props = {
  problem: SessionProblem
  onSignInAgain: () => void
  onSignOut: () => void
}

// Shown over the app when the sign-in session ends or the account is refused.
// It is a modal alert dialog: focus moves in, Tab stays inside, and the page behind it is inert.
export function SessionPanel({ problem, onSignInAgain, onSignOut }: Props) {
  const primary = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    primary.current?.focus()
    const app = document.querySelector<HTMLElement>('.app-shell > .app-content')
    app?.setAttribute('inert', '')
    return () => app?.removeAttribute('inert')
  }, [])

  function trapTab(event: React.KeyboardEvent) {
    if (event.key !== 'Tab' || !panel.current) return
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>('button, a[href]'))
    if (focusable.length === 0) return
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

  const ended = problem.kind === 'ended'

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={panel}
        className="modal-panel session-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-panel-title"
        aria-describedby="session-panel-body"
        onKeyDown={trapTab}
      >
        <div className="modal-head">
          <div>
            <h2 id="session-panel-title">{ended ? 'Your session ended' : 'This account cannot use CardCap'}</h2>
          </div>
        </div>
        <div id="session-panel-body" className="session-body">
          {ended ? (
            <>
              <p>For your security, CardCap signs you out after a while. Sign in again to keep working.</p>
              <p>
                {problem.hasUnsavedEdits
                  ? 'Your contacts are saved. We kept the edits you had not saved yet and will put them back when you return.'
                  : 'Your contacts are saved.'}
              </p>
            </>
          ) : (
            <>
              <p>{problem.message}</p>
              <p>
                If you think this is a mistake, email <a href="mailto:cody@copperstateit.com">cody@copperstateit.com</a> from the address you
                signed in with.
              </p>
            </>
          )}
        </div>
        <div className="modal-actions">
          {ended ? (
            <>
              <button ref={primary} className="btn primary" type="button" onClick={onSignInAgain}>
                Sign in again
              </button>
              <button className="btn" type="button" onClick={onSignOut}>
                Sign out
              </button>
            </>
          ) : (
            <button ref={primary} className="btn primary" type="button" onClick={onSignOut}>
              Sign out and use another account
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
