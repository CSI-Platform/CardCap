import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { apiGet, apiJson, apiUpload } from './lib/api'
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
  const [accessCode, setAccessCode] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement | null>(null)
  const importInput = useRef<HTMLInputElement | null>(null)
  const selectedIdRef = useRef('')

  const selectContact = useCallback((contact: Contact | null) => {
    const nextId = contact?.id || ''
    selectedIdRef.current = nextId
    setSelectedId(nextId)
    setDraft(contact ? cloneContact(contact) : null)
  }, [])

  const loadContacts = useCallback(
    async (preferredId?: string) => {
      setLoading(true)
      setError('')
      try {
        const data = await apiGet<{ contacts: Contact[] }>('/api/contacts')
        const sortedContacts = sortContactsByName(data.contacts)
        setContacts(sortedContacts)
        setAuthRequired(false)
        const nextId = preferredId || selectedIdRef.current
        selectContact(sortedContacts.find((contact) => contact.id === nextId) || sortedContacts[0] || null)
      } catch (err) {
        const message = messageFrom(err)
        if (message.includes('Private beta code') || message.includes('Cloudflare Access')) {
          setAuthRequired(true)
          setError('')
        } else {
          setError(message)
        }
      } finally {
        setLoading(false)
      }
    },
    [selectContact],
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadContacts(), 0)
    return () => window.clearTimeout(timeout)
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
      setError(messageFrom(err))
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
      setError(messageFrom(err))
    } finally {
      setBusy(false)
      if (importInput.current) importInput.current.value = ''
    }
  }

  async function unlockBeta() {
    if (!accessCode.trim()) return
    setBusy(true)
    setError('')
    try {
      await apiJson<{ ok: boolean }>('/api/session', 'POST', { code: accessCode.trim() })
      setAccessCode('')
      await loadContacts()
    } catch (err) {
      setError(messageFrom(err))
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
      setError(messageFrom(err))
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
      selectContact(next[0] || null)
      setNotice('Deleted.')
    } catch (err) {
      setError(messageFrom(err))
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
      setError(messageFrom(err))
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>CardCap</h1>
          <p>Business cards in. Follow-up CRM out.</p>
        </div>
        <div className="toolbar">
          <button className="btn primary" type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
            Add Cards
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
          <button className="btn" type="button" onClick={() => exportUrl('/api/export.csv')}>
            CSV
          </button>
          <button className="btn" type="button" onClick={() => exportUrl('/api/export.vcf')}>
            vCard
          </button>
          <button className="btn" type="button" onClick={() => exportUrl('/api/export.json')}>
            JSON
          </button>
          <button className="btn" type="button" onClick={() => exportUrl('/api/export.html')}>
            HTML
          </button>
        </div>
      </header>

      {(notice || error) && <div className={error ? 'banner error' : 'banner'}>{error || notice}</div>}

      {authRequired && (
        <main className="unlock-screen">
          <section className="unlock-panel">
            <h2>Private beta</h2>
            <p>Enter the CardCap beta code to open your contact workspace.</p>
            <label>
              Beta code
              <input
                type="password"
                value={accessCode}
                onChange={(event) => setAccessCode(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void unlockBeta()
                }}
              />
            </label>
            <button className="btn primary" type="button" onClick={() => void unlockBeta()} disabled={busy || !accessCode.trim()}>
              Unlock
            </button>
          </section>
        </main>
      )}

      {!authRequired && (
      <main className="workspace">
        <aside className="sidebar">
          <div className="filters">
            <label>
              Name Search
              <input
                type="search"
                value={query}
                placeholder="Search the main list"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <label>
              Status
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}>
                <option value="">All contacts</option>
                <option value="__review__">Review queue</option>
                <option value="New">New</option>
                <option value="Follow up">Follow up</option>
                <option value="Active">Active</option>
                <option value="Archived">Archived</option>
              </select>
            </label>
          </div>

          <div className="contact-list">
            <div className="list-head">
              <strong>Main List</strong>
              <span>
                {filteredContacts.length} shown
                {reviewCount > 0 ? ` / ${reviewCount} review` : ''}
              </span>
            </div>
            {loading && <div className="empty">Loading contacts...</div>}
            {!loading && filteredContacts.length === 0 && (
              <div className="empty">
                <strong>No contacts yet.</strong>
                <span>Tap Add Cards to take a photo or upload from Photos.</span>
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
                    onClick={() => selectContact(contact)}
                  >
                    {contact.sourceImageUrl ? <img src={contact.sourceImageUrl} alt="" /> : <span className="avatar-fallback" />}
                    <span>
                      <strong>{contactDisplayName(contact)}</strong>
                      <small>{[contact.company, contact.role].filter(Boolean).join(' - ') || contact.email || 'Needs review'}</small>
                    </span>
                  </button>
                ))}
              </section>
            ))}
          </div>
        </aside>

        <section className="editor">
          {!draft && (
            <div className="empty editor-empty">
              <strong>Ready for your first batch.</strong>
              <span>Upload business card photos and CardCap will create editable contact drafts.</span>
            </div>
          )}
          {draft && (
            <>
              <div className="editor-head">
                <div>
                  <h2>{draft.name || 'Review Contact'}</h2>
                  <p>{[draft.company, draft.role].filter(Boolean).join(' - ') || 'Extracted card draft'}</p>
                  {contactNeedsReview(draft) && <div className="review-chip">Needs review</div>}
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
                <span className="confidence">{Math.round(draft.extractionConfidence * 100)}%</span>
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
                  <select
                    value={draft.status}
                    onChange={(event) => updateDraft('status', event.currentTarget.value as ContactStatus)}
                  >
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
                  <textarea
                    value={draft.phones.join('\n')}
                    onChange={(event) => updateDraft('phones', splitLines(event.currentTarget.value))}
                  />
                </label>
                <label>
                  Tags
                  <textarea
                    value={draft.tags.join('\n')}
                    onChange={(event) => updateDraft('tags', splitLines(event.currentTarget.value))}
                  />
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

              <div className="actions">
                <button className="btn primary" type="button" onClick={() => void saveDraft()} disabled={busy}>
                  Save Contact
                </button>
                {contactNeedsReview(draft) && (
                  <button className="btn" type="button" onClick={() => void markReviewed()} disabled={busy}>
                    Mark Reviewed
                  </button>
                )}
                <button className="btn danger" type="button" onClick={() => void deleteSelected()} disabled={busy}>
                  Delete
                </button>
              </div>
            </>
          )}
        </section>

        <aside className="source-panel">
          <div className="source-head">
            <h2>Card Photo</h2>
            {draft?.sourceImageUrl && (
              <a href={draft.sourceImageUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            )}
          </div>
          <div className="source-body">
            {draft?.sourceImageUrl ? (
              <img src={draft.sourceImageUrl} alt={`Business card for ${draft.name || 'contact'}`} />
            ) : (
              <div className="empty">Source images appear here after upload.</div>
            )}
          </div>
        </aside>
      </main>
      )}
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

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default App
