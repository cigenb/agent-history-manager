import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

interface Branch {
  /** `data-card-key` of the middle-column card the branch grows from */
  from: string
  /** Third-column cards, each marked `data-leaf` */
  children: ReactNode
}

interface Edge {
  d: string
  muted: boolean
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) * 0.5
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

const sameEdges = (a: Edge[], b: Edge[]) => a.length === b.length && a.every((e, i) => e.d === b[i].d && e.muted === b[i].muted)

/**
 * Dotted canvas: one node on the left, a column of cards in the middle, and optionally a third column that
 * branches from one middle card. Middle cards carry `data-card` (`data-muted="1"` greys out their curve).
 */
export default function GraphCanvas({
  target,
  children,
  branch,
}: {
  target: ReactNode
  children: ReactNode
  branch?: Branch
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const leavesRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<Edge[]>([])

  /** Curves are measured from the laid-out cards, so they follow wrapping, scrolling and resizing. */
  const measure = useCallback(() => {
    const canvas = canvasRef.current
    const t = targetRef.current?.getBoundingClientRect()
    const list = listRef.current
    if (!canvas || !t || !list) return
    const c = canvas.getBoundingClientRect()
    // Cards scrolled out of a column still get a curve, ending at the column's top or bottom edge.
    const clampY = (y: number, box: DOMRect) => Math.min(Math.max(y, box.top), box.bottom) - c.top
    const lb = list.getBoundingClientRect()
    const x1 = t.right - c.left
    const y1 = t.top + t.height / 2 - c.top
    const next: Edge[] = [...list.querySelectorAll<HTMLElement>('[data-card]')].map((el) => {
      const r = el.getBoundingClientRect()
      return { d: curve(x1, y1, r.left - c.left, clampY(r.top + 22, lb)), muted: el.dataset.muted === '1' }
    })

    const leaves = leavesRef.current
    const anchor = branch && list.querySelector<HTMLElement>(`[data-card-key="${branch.from}"]`)
    if (leaves && anchor) {
      const a = anchor.getBoundingClientRect()
      const fb = leaves.getBoundingClientRect()
      const ax = a.right - c.left
      const ay = clampY(a.top + 22, lb)
      for (const el of leaves.querySelectorAll<HTMLElement>('[data-leaf]')) {
        const r = el.getBoundingClientRect()
        next.push({ d: curve(ax, ay, r.left - c.left, clampY(r.top + r.height / 2, fb)), muted: false })
      }
    }
    // Measuring runs after every render; only store real changes, or setting state would render forever.
    setEdges((prev) => (sameEdges(prev, next) ? prev : next))
  }, [branch])

  useLayoutEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    for (const el of [canvasRef.current, listRef.current, leavesRef.current]) if (el) ro.observe(el)
    for (const el of listRef.current?.querySelectorAll('[data-card]') ?? []) ro.observe(el)
    return () => ro.disconnect()
  })

  return (
    <div className={`mem-canvas${branch ? ' branched' : ''}`} ref={canvasRef}>
      <svg className="mem-edges" aria-hidden>
        {edges.map((e, i) => (
          <path key={i} d={e.d} className={e.muted ? 'muted' : undefined} />
        ))}
      </svg>
      <div className="mem-target" ref={targetRef}>
        {target}
      </div>
      <div className="mem-affected" ref={listRef} onScroll={measure}>
        {children}
      </div>
      {branch && (
        <div className="mem-leaves" ref={leavesRef} onScroll={measure}>
          {branch.children}
        </div>
      )}
    </div>
  )
}
