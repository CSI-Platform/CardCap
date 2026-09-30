import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { LoginGate } from './components/LoginGate'
import { Menu } from './components/Menu'
import { SessionPanel, type SessionProblem } from './components/SessionPanel'
import { SignOutConfirm } from './components/SignOutConfirm'
import { ApiError, apiGet, apiJson, apiUpload, relativeEdgeUrl } from './lib/api'
import { contactDisplayName, groupContactsByInitial, sortContactsByName } from './shared/contacts'
import { contactNeedsReview, reviewedContact } from './shared/review'
import type { Contact, ContactStatus } from './shared/types'

function App() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [draft, setDraft] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [accessMode, setAccessMode] = useState(false)
  const [photoTab, setPhotoTab] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [passwordPanelOpen, setPasswordPanelOpen] = useState(false)
  const [accountPassword, setAccountPassword] = useState('')
  const [accountPasswordConfirm, setAccountPasswordConfirm] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [sessionProblem, setSessionProblem] = useState<SessionProblem | null>(null)
  const signedInRef = useRef(false)
  const signedOutRef = useRef(false)
  const draftRef = useRef<Contact | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const importInput = useRef<HTMLInputElement | null>(null)
  const selectedIdRef = useRef('')

  const selectContact = useCallback((contact: Contact | null) => {
    const nextId = contact?.id || ''
    selectedIdRef.current = nextId
    setSelectedId(nextId)
    setPhotoTab(false)
    setDraft(contact ? cloneContact(contact) : null)
  }, [])

  const loadContacts = useCallback(
    async (preferredId?: string) => {
      setLoading(true)
      setError('')
      try {
        const data = await apiGet<{ contacts: Contact[] }>('/api/contacts')
        if (signedOutRef.current) return undefined // a slow load must not bring the screen back after sign out
        const sortedContacts = sortContactsByName(data.contacts)
        setContacts(sortedContacts)
        setAuthRequired(false)
        const nextId = preferredId || selectedIdRef.current
        selectContact(sortedContacts.find((contact) => contact.id === nextId) || null)
        return sortedContacts
      } catch (err) {
        if (signedInRef.current && err instanceof ApiError && (err.kind === 'session-ended' || err.kind === 'denied')) {
          reportSessionProblem(err)
        } else if (messageFrom(err).includes('Sign in to continue')) {
          setAuthRequired(true)
          setError('')
        } else {
          setError(messageFrom(err))
        }
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectContact],
  )

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const me = await apiGet<{ email: string }>('/api/me')
        if (cancelled) return
        setUserEmail(me.email)
        signedInRef.current = true
        // In Access mode the edge handles sign-in, so the password screens are not offered.
        const config = await apiGet<{ mode?: string }>('/api/auth/config').catch(() => ({}) as { mode?: string })
        if (!cancelled) setAccessMode(config.mode === 'access')
        const loaded = await loadContacts()
        if (loaded) restorePendingDraft(loaded)
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.kind === 'denied') {
          // Signed in at the edge but refused by CardCap: explain it instead of offering a sign-in form.
          reportSessionProblem(err)
        } else {
          setAuthRequired(true)
        }
        setLoading(false)
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadContacts])

  const filteredContacts = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return sortContactsByName(contacts)
      .filter((contact) => (statusFilter === '__review__' ? contactNeedsReview(contact) : !statusFilter || contact.status === statusFilter))
      .filter((contact) => {
        if (!normalized) return true
        const haystack = [
          contact.name,
          contact.company,
          contact.role,
          contact.email,
          contact.website,
          contact.address,
          contact.notes,
          contact.nextStep,
          ...contact.phones,
          ...contact.tags,
        ]
          .join(' ')
          .toLowerCase()
        return haystack.includes(normalized)
      })
  }, [contacts, query, statusFilter])

  const contactGroups = useMemo(() => groupContactsByInitial(filteredContacts), [filteredContacts])
  const reviewCount = useMemo(() => contacts.filter(contactNeedsReview).length, [contacts])

  draftRef.current = draft

  function reportSessionProblem(err: ApiError) {
    if (err.kind === 'denied') {
      // A 403 only comes from Access mode, where the edge logout path is the way out.
      setSessionProblem({ kind: 'denied', message: err.message, logoutUrl: err.logoutUrl || '/cdn-cgi/access/logout' })
      return
    }
    const pending = draftRef.current
    const original = pending ? contacts.find((contact) => contact.id === pending.id) : null
    const hasUnsavedEdits = Boolean(pending && original && JSON.stringify(pending) !== JSON.stringify(original))
    if (pending && hasUnsavedEdits) writePendingDraft(pending)
    setSessionProblem({ kind: 'ended', hasUnsavedEdits })
  }

  // One place decides how a failed request is shown: session ended, account refused, offline, or a plain message.
  function fail(err: unknown) {
    if (err instanceof ApiError && signedInRef.current && (err.kind === 'session-ended' || err.kind === 'denied')) {
      reportSessionProblem(err)
      return
    }
    setError(messageFrom(err))
  }

  function restorePendingDraft(loaded: Contact[]) {
    const saved = readPendingDraft()
    if (!saved) return
    clearPendingDraft()
    if (!loaded.some((contact) => contact.id === saved.id)) return
    setSelectedId(saved.id)
    selectedIdRef.current = saved.id
    setDraft(saved)
    setNotice('Welcome back. We restored the edits you had not saved. Review them, then save.')
  }

  function signInAgain() {
    // Reloading this page sends the browser through Access sign-in and back to the same page.
    window.location.reload()
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(true)
    setError('')
    setNotice(`Uploading ${files.length} card${files.length === 1 ? '' : 's'}...`)
    try {
      let lastContact: Contact | null = null
      let duplicateCount = 0
      for (const file of Array.from(files)) {
        const data = await apiUpload<{ contact: Contact; extractionMode: string; duplicate: { id: string; reasons: string[] } | null }>(
          '/api/cards/upload',
          file,
        )
        lastContact = data.contact
        if (data.duplicate) duplicateCount += 1
      }
      await loadContacts(lastContact?.id)
      setNotice(
        duplicateCount > 0
          ? `Cards processed. ${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'} merged.`
          : 'Cards added. Review the extracted fields before follow-up.',
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function handleImport(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    setError('')
    setNotice(`Importing ${file.name}...`)
    try {
      const data = await apiUpload<{
        format: string
        imported: number
        created: number
        merged: number
        skipped: number
      }>('/api/contacts/import', file)
      await loadContacts()
      setNotice(
        `Imported ${data.imported} ${data.format.toUpperCase()} contact${data.imported === 1 ? '' : 's'}. ` +
          `${data.created} new, ${data.merged} merged${data.skipped ? `, ${data.skipped} skipped` : ''}.`,
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
      if (importInput.current) importInput.current.value = ''
    }
  }

  async function handleSignedIn() {
    signedOutRef.current = false
    signedInRef.current = true
    setAuthRequired(false)
    const me = await apiGet<{ email: string }>('/api/me').catch(() => null)
    setUserEmail(me?.email || '')
    await loadContacts()
  }

  // In Access mode signing out ends the shared CSI sign-in (Blackboard too), so ask first; the old sign-in only ends this app's session.
  function askSignOut() {
    if (accessMode || sessionProblem?.kind === 'denied') setConfirmSignOut(true)
    else void signOut()
  }

  function cancelSignOut() {
    setConfirmSignOut(false)
    // Put focus back on the Account button (when that is where the person came from).
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label^="Account menu"]')?.focus())
  }

  async function signOut() {
    setConfirmSignOut(false)
    const result = await apiJson<{ ok: boolean; logoutUrl?: string }>('/api/auth/logout', 'POST').catch(() => undefined)
    const logoutUrl = relativeEdgeUrl(result?.logoutUrl) || (sessionProblem?.kind === 'denied' ? relativeEdgeUrl(sessionProblem.logoutUrl) : undefined)
    if (logoutUrl) {
      clearPendingDraft()
      window.location.assign(logoutUrl)
      return
    }
    signedOutRef.current = true
    signedInRef.current = false
    setSessionProblem(null)
    setUserEmail('')
    setContacts([])
    setPasswordPanelOpen(false)
    setAccountPassword('')
    setAccountPasswordConfirm('')
    selectContact(null)
    setAuthRequired(true)
  }

  async function saveAccountPassword() {
    if (accountPassword !== accountPasswordConfirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await apiJson<{ ok: boolean }>('/api/auth/set-password', 'POST', { password: accountPassword })
      setPasswordPanelOpen(false)
      setAccountPassword('')
      setAccountPasswordConfirm('')
      setNotice('Password saved.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function saveDraft() {
    if (!draft) return
    if (!draft.name.trim()) {
      setError('Name is required before saving.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const data = await apiJson<{ contact: Contact }>(`/api/contacts/${encodeURIComponent(draft.id)}`, 'PUT', {
        contact: draft,
      })
      setContacts((current) => sortContactsByName(current.map((contact) => (contact.id === data.contact.id ? data.contact : contact))))
      selectContact(data.contact)
      setNotice('Saved.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function deleteSelected() {
    if (!draft) return
    const ok = window.confirm(`Delete ${draft.name || 'this contact'}?`)
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      await apiJson<{ deleted: boolean }>(`/api/contacts/${encodeURIComponent(draft.id)}`, 'DELETE')
      const next = sortContactsByName(contacts.filter((contact) => contact.id !== draft.id))
      setContacts(next)
      selectContact(null)
      setNotice('Deleted.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function markReviewed() {
    if (!draft) return
    if (!draft.name.trim()) {
      setError('Name is required before marking reviewed.')
      return
    }
    const next = reviewedContact(draft)
    setBusy(true)
    setError('')
    try {
      const data = await apiJson<{ contact: Contact }>(`/api/contacts/${encodeURIComponent(next.id)}`, 'PUT', {
        contact: next,
      })
      setContacts((current) => sortContactsByName(current.map((contact) => (contact.id === data.contact.id ? data.contact : contact))))
      selectContact(data.contact)
      setNotice('Marked reviewed.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  function updateDraft<K extends keyof Contact>(key: K, value: Contact[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  }

  function exportUrl(path: string) {
    window.location.href = path
  }

  const view: 'loading' | 'empty' | 'list' | 'edit' =
    contacts.length === 0 ? (loading ? 'loading' : 'empty') : draft ? 'edit' : 'list'

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to contacts
      </a>
      <div className="app-content" aria-busy={loading}>
      <div className="brand-bar" aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <picture>
            <source srcSet="/brand/csi-monogram-dark.svg" media="(prefers-color-scheme: dark)" />
            <img className="brand-mark" src="/brand/csi-monogram-light.svg" alt="" width="36" height="36" />
          </picture>
          <div className="brand-text">
            <span className="brand-org">Copper State Intelligence</span>
            <h1>CardCap</h1>
          </div>
        </div>
        {!authRequired && (
          <div className="toolbar">
            <button className="btn primary" type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
              Add cards
            </button>
            <input
              ref={fileInput}
              className="hidden-input"
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={(event) => void handleFiles(event.currentTarget.files)}
            />
            <button className="btn" type="button" onClick={() => importInput.current?.click()} disabled={busy}>
              Import
            </button>
            <input
              ref={importInput}
              className="hidden-input"
              type="file"
              accept=".csv,.vcf,.vcard,.json,text/csv,text/vcard,application/json"
              onChange={(event) => void handleImport(event.currentTarget.files)}
            />
            <Menu
              label="Export"
              items={[
                { label: 'CSV', onSelect: () => exportUrl('/api/export.csv') },
                { label: 'vCard', onSelect: () => exportUrl('/api/export.vcf') },
                { label: 'JSON', onSelect: () => exportUrl('/api/export.json') },
                { label: 'HTML', onSelect: () => exportUrl('/api/export.html') },
                { label: 'iContact CSV', onSelect: () => exportUrl('/api/export.icontact.csv') },
              ]}
            />
            {userEmail && (
              <Menu
                label="Account"
                ariaLabel={`Account menu for ${userEmail}`}
                items={[
                  { heading: `Signed in as ${userEmail}` },
                  ...(accessMode ? [] : [{ label: 'Set password', onSelect: () => setPasswordPanelOpen(true) }]),
                  { label: 'Sign out', onSelect: askSignOut },
                ]}
              />
            )}
          </div>
        )}
      </header>

      {(notice || error) && (
        <div className={error ? 'banner error' : 'banner'} role={error ? 'alert' : 'status'}>
          {error || notice}
        </div>
      )}

      {passwordPanelOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPasswordPanelOpen(false)}>
          <section
            className="modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-panel-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <h2 id="password-panel-title">Account Password</h2>
                <p>{userEmail}</p>
              </div>
              <button className="btn" type="button" onClick={() => setPasswordPanelOpen(false)} disabled={busy}>
                Close
              </button>
            </div>
            <label>
              New password
              <input
                type="password"
                value={accountPassword}
                autoComplete="new-password"
                onChange={(event) => setAccountPassword(event.currentTarget.value)}
              />
            </label>
            <label>
              Confirm password
              <input
                type="password"
                value={accountPasswordConfirm}
                autoComplete="new-password"
                onChange={(event) => setAccountPasswordConfirm(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveAccountPassword()
                }}
              />
            </label>
            <div className="modal-actions">
              <button
                className="btn primary"
                type="button"
                onClick={() => void saveAccountPassword()}
                disabled={busy || !accountPassword || !accountPasswordConfirm}
              >
                Save password
              </button>
              <button className="btn" type="button" onClick={() => setPasswordPanelOpen(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {authRequired && <LoginGate onSignedIn={() => void handleSignedIn()} />}

      {!authRequired && (
        <main className={`workspace view-${view}${photoTab ? ' show-photo' : ''}`} id="main" tabIndex={-1}>
          {view === 'loading' && <div className="empty">Loading contacts...</div>}

          {view === 'empty' && (
            <section className="welcome" aria-labelledby="welcome-title">
              <h2 id="welcome-title">Add your first business cards</h2>
              <p>Choose Add cards at the top to take a photo or pick pictures of business cards. CardCap reads each one, you check it, and then you save it to your list.</p>
              <ol className="welcome-steps">
                <li>
                  <strong>Add</strong>
                  <span>Photos of cards</span>
                </li>
                <li>
                  <strong>Review</strong>
                  <span>Fix anything it missed</span>
                </li>
                <li>
                  <strong>Export</strong>
                  <span>CSV, vCard or iContact</span>
                </li>
              </ol>
              <div className="welcome-actions">
                <button className="btn" type="button" onClick={() => importInput.current?.click()} disabled={busy}>
                  Import a file
                </button>
              </div>
            </section>
          )}

          {(view === 'list' || view === 'edit') && (
            <aside className="sidebar" aria-label="Contacts">
              <div className="filters">
                <label>
                  Search
                  <input
                    type="search"
                    value={query}
                    placeholder="Name, company, email"
                    onChange={(event) => setQuery(event.currentTarget.value)}
                  />
                </label>
                <label>
                  Show
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}>
                    <option value="">All contacts</option>
                    <option value="__review__">Needs review</option>
                    <option value="New">New</option>
                    <option value="Follow up">Follow up</option>
                    <option value="Active">Active</option>
                    <option value="Archived">Archived</option>
                  </select>
                </label>
              </div>

              <div className="contact-list">
                <div className="list-head">
                  <strong>Contacts</strong>
                  <span>
                    {filteredContacts.length} shown
                    {reviewCount > 0 ? `, ${reviewCount} to review` : ''}
                  </span>
                </div>
                {filteredContacts.length === 0 && (
                  <div className="empty">
                    <strong>No contacts match.</strong>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        setQuery('')
                        setStatusFilter('')
                      }}
                    >
                      Clear search
                    </button>
                  </div>
                )}
                {contactGroups.map((group) => (
                  <section className="contact-group" key={group.letter} aria-label={`${group.letter} contacts`}>
                    <div className="letter-row">{group.letter}</div>
                    {group.contacts.map((contact) => (
                      <button
                        className={`contact-row ${contact.id === selectedId ? 'active' : ''}`}
                        key={contact.id}
                        type="button"
                        aria-current={contact.id === selectedId ? 'true' : undefined}
                        onClick={() => selectContact(contact)}
                      >
                        {contact.sourceImageUrl ? <img src={contact.sourceImageUrl} alt="" /> : <span className="avatar-fallback" aria-hidden="true">{contactDisplayName(contact).trim().charAt(0).toUpperCase()}</span>}
                        <span className="contact-text">
                          <strong>{contactDisplayName(contact)}</strong>
                          <small>{[contact.company, contact.role].filter(Boolean).join(' - ') || contact.email || 'Needs review'}</small>
                        </span>
                        {contactNeedsReview(contact) && <span className="row-flag">Review</span>}
                      </button>
                    ))}
                  </section>
                ))}
              </div>
            </aside>
          )}

          {view === 'edit' && draft && (
            <>
              <section className="editor" aria-label="Edit contact">
                <div className="phone-bar">
                  <button className="btn back-button" type="button" onClick={() => selectContact(null)}>
                    All contacts
                  </button>
                  <div className="segmented" role="group" aria-label="Show">
                    <button type="button" aria-pressed={!photoTab} onClick={() => setPhotoTab(false)}>
                      Details
                    </button>
                    <button type="button" aria-pressed={photoTab} onClick={() => setPhotoTab(true)}>
                      Card photo
                    </button>
                  </div>
                </div>
                <div className="editor-body">
                  <div className="editor-head">
                    <div>
                      <h2>{draft.name || 'Review contact'}</h2>
                      <p>{[draft.company, draft.role].filter(Boolean).join(' - ') || 'Extracted card draft'}</p>
                      <div className="head-flags">
                        {contactNeedsReview(draft) && <span className="review-chip">Needs review</span>}
                        <span className="confidence" title="How sure CardCap is about what it read">
                          {Math.round(draft.extractionConfidence * 100)}%
                        </span>
                      </div>
                    </div>
                    <div className="quick-links">
                      {draft.email && <a href={`mailto:${draft.email}`}>Email</a>}
                      {draft.phones[0] && <a href={`tel:${phoneHref(draft.phones[0])}`}>Call</a>}
                      {draft.website && (
                        <a href={draft.website} target="_blank" rel="noreferrer">
                          Website
                        </a>
                      )}
                      {draft.address && (
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(draft.address)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Map
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="form-grid">
                    <label>
                      Name
                      <input value={draft.name} onChange={(event) => updateDraft('name', event.currentTarget.value)} />
                    </label>
                    <label>
                      Company
                      <input value={draft.company} onChange={(event) => updateDraft('company', event.currentTarget.value)} />
                    </label>
                    <label>
                      Role
                      <input value={draft.role} onChange={(event) => updateDraft('role', event.currentTarget.value)} />
                    </label>
                    <label>
                      Status
                      <select value={draft.status} onChange={(event) => updateDraft('status', event.currentTarget.value as ContactStatus)}>
                        <option>New</option>
                        <option>Follow up</option>
                        <option>Active</option>
                        <option>Archived</option>
                      </select>
                    </label>
                    <label>
                      Email
                      <input value={draft.email} onChange={(event) => updateDraft('email', event.currentTarget.value)} />
                    </label>
                    <label>
                      Website
                      <input value={draft.website} onChange={(event) => updateDraft('website', normalizeUrl(event.currentTarget.value))} />
                    </label>
                    <label>
                      Phones
                      <textarea value={draft.phones.join('\n')} onChange={(event) => updateDraft('phones', splitLines(event.currentTarget.value))} />
                    </label>
                    <label>
                      Tags
                      <textarea value={draft.tags.join('\n')} onChange={(event) => updateDraft('tags', splitLines(event.currentTarget.value))} />
                    </label>
                    <label className="wide">
                      Address
                      <input value={draft.address} onChange={(event) => updateDraft('address', event.currentTarget.value)} />
                    </label>
                    <label className="wide">
                      Next step
                      <input value={draft.nextStep} onChange={(event) => updateDraft('nextStep', event.currentTarget.value)} />
                    </label>
                    <label className="wide">
                      Notes
                      <textarea value={draft.notes} onChange={(event) => updateDraft('notes', event.currentTarget.value)} />
                    </label>
                  </div>
                </div>

                <div className="actions">
                  <button className="btn primary" type="button" onClick={() => void saveDraft()} disabled={busy}>
                    Save contact
                  </button>
                  {contactNeedsReview(draft) && (
                    <button className="btn" type="button" onClick={() => void markReviewed()} disabled={busy}>
                      Mark reviewed
                    </button>
                  )}
                  <button className="btn danger" type="button" onClick={() => void deleteSelected()} disabled={busy}>
                    Delete
                  </button>
                </div>
              </section>

              <aside className="source-panel" aria-label="Card photo">
                <div className="source-head">
                  <h2>Card photo</h2>
                  {draft.sourceImageUrl && (
                    <a href={draft.sourceImageUrl} target="_blank" rel="noreferrer">
                      Open full size
                    </a>
                  )}
                </div>
                <div className="source-body">
                  {draft.sourceImageUrl ? (
                    <img src={draft.sourceImageUrl} alt={`Business card for ${draft.name || 'contact'}`} />
                  ) : (
                    <div className="empty">This contact has no card photo.</div>
                  )}
                </div>
              </aside>
            </>
          )}
        </main>
      )}
      </div>
      {confirmSignOut && <SignOutConfirm onConfirm={() => void signOut()} onCancel={cancelSignOut} />}
      {sessionProblem && !confirmSignOut && <SessionPanel problem={sessionProblem} onSignInAgain={signInAgain} onSignOut={askSignOut} />}
    </div>
  )
}

function cloneContact(contact: Contact): Contact {
  return {
    ...contact,
    phones: [...contact.phones],
    tags: [...contact.tags],
  }
}

function splitLines(value: string): string[] {
  return Array.from(new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)))
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function phoneHref(value: string): string {
  return value.replace(/[^\d+]/g, '')
}

const PENDING_DRAFT_KEY = 'cardcap:pending-draft'

// Edits are kept only in this browser tab's session storage, only while the sign-in page is visited, and cleared after restore.
function writePendingDraft(contact: Contact) {
  try {
    sessionStorage.setItem(PENDING_DRAFT_KEY, JSON.stringify(contact))
  } catch {
    // Storage can be unavailable (private windows); edits simply are not kept.
  }
}

function readPendingDraft(): Contact | null {
  try {
    const raw = sessionStorage.getItem(PENDING_DRAFT_KEY)
    return raw ? (JSON.parse(raw) as Contact) : null
  } catch {
    return null
  }
}

function clearPendingDraft() {
  try {
    sessionStorage.removeItem(PENDING_DRAFT_KEY)
  } catch {
    // ignore
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default App
