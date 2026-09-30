import { useEffect, useId, useRef, useState } from 'react'

export type MenuItem = {
  label: string
  onSelect: () => void
  /** small non-interactive line shown above the items (for example who is signed in) */
  heading?: never
}

type Props = {
  /** visible button text */
  label: string
  /** accessible name when it should say more than the visible text */
  ariaLabel?: string
  items: Array<MenuItem | { heading: string }>
  disabled?: boolean
}

// A button that opens a short list of actions. Keyboard: Enter/Space/ArrowDown open, arrows/Home/End move,
// Escape closes and returns focus to the button, Tab or a click elsewhere closes.
export function Menu({ label, ariaLabel, items, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const panelId = useId()
  const actions = items.filter((item): item is MenuItem => 'onSelect' in item)

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open])

  function close(returnFocus: boolean) {
    setOpen(false)
    if (returnFocus) button.current?.focus()
  }

  function onPanelKeyDown(event: React.KeyboardEvent) {
    const entries = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])
    const index = entries.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      entries[(index + 1) % entries.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      entries[(index - 1 + entries.length) % entries.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      entries[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      entries[entries.length - 1]?.focus()
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="menu" ref={root}>
      <button
        ref={button}
        className="btn menu-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {label}
        <span className="menu-caret" aria-hidden="true" />
      </button>
      {open && actions.length > 0 && (
        <div className="menu-panel" id={panelId} role="menu" aria-label={ariaLabel || label} onKeyDown={onPanelKeyDown}>
          {items.map((item, index) =>
            'onSelect' in item ? (
              <button
                key={`${item.label}-${index}`}
                className="menu-item"
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  close(true)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            ) : (
              <div key={`${item.heading}-${index}`} className="menu-heading" role="presentation">
                {item.heading}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}
