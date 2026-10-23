import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  danger?: boolean
  /** Shown greyed out and does nothing when clicked */
  disabled?: boolean
  onSelect: () => void
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

export default function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.min(menu.x, window.innerWidth - width - 8),
      top: Math.min(menu.y, window.innerHeight - height - 8),
    })
  }, [menu])

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape closes only the menu, not a panel or dialog underneath it.
      e.stopPropagation()
      onClose()
    }
    // Capture phase: panels and dialogs stop mousedown/keydown from bubbling, which would keep the menu open.
    window.addEventListener('mousedown', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div className="context-menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item) => (
        <button
          key={item.label}
          className={`context-item${item.danger ? ' danger' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
