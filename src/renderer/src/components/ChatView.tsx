import { useT, useLanguage } from '../i18n'
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ImageData, SessionDetail, Turn } from '../../../shared/types'
import DocEdits, { type PreviewDoc } from './DocEditCard'
import FindBar from './FindBar'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Close } from './Icons'
import Markdown, { CopyButton } from './Markdown'
import { clock, dateTime, dayKey, dayLabel } from '../lib/time'

/** A content search hit to scroll to and highlight once its session file is shown. */
export interface SearchFocus {
  fileId: string
  /** Exact excerpt of the matching message (SearchHit.needle) */
  needle: string
  terms: string[]
  /** Changes on every click, so opening the same hit again scrolls to it again */
  seq: number
}

interface Props {
  detail: SessionDetail | null
  loading: boolean
  hasSelection: boolean
  focus: SearchFocus | null
  onPreviewDoc: PreviewDoc
  onSwitchVersion: (id: string) => void
}

/** Part of a turn that has to be unfolded to show the hit: commentary between tool calls, or a clamped prompt. */
type Reveal = 'text' | 'steps'

interface Hit {
  turn: number
  reveal: Reveal
  terms: string[]
}

function locateHit(turns: Turn[], f: SearchFocus): Hit | null {
  const allTerms = (s: string) => {
    const lower = s.toLowerCase()
    return f.terms.every((t) => lower.includes(t))
  }
  // The excerpt only surrounds the first term, so the other terms must be there too.
  const exact = (s: string) => s.includes(f.needle) && allTerms(s)
  // Fallback when the excerpt is not found verbatim (the file changed since the search): any text holding every term.
  for (const test of [exact, allTerms]) {
    for (let i = 0; i < turns.length; i++) {
      const x = turns[i]
      if (x.kind === 'user' && test(x.text)) return { turn: i, reveal: 'text', terms: f.terms }
      if (x.kind !== 'assistant') continue
      if (test(x.text)) return { turn: i, reveal: 'text', terms: f.terms }
      if (x.steps.some(test)) return { turn: i, reveal: 'steps', terms: f.terms }
    }
  }
  return null
}

const HIGHLIGHT = 'search-hit'

/** Ranges of every term inside `root`, in document order. Matches split across elements are not found. */
function termRanges(root: Node, terms: string[]): Range[] {
  const out: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const lower = (n.nodeValue ?? '').toLowerCase()
    for (const t of terms) {
      for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) {
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + t.length)
        out.push(r)
      }
    }
  }
  return out.sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b))
}

function VersionPicker({ detail, onSwitch }: { detail: SessionDetail; onSwitch: (id: string) => void }) {
  const { language } = useLanguage()
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="version-picker" ref={ref}>
      <button className="version-btn" onClick={() => setOpen((v) => !v)} title={t.versionHint}>
        {t.versions(detail.versions.length)}
        <ChevronDown width={12} height={12} />
      </button>
      {open && (
        <div className="version-menu">
          {detail.versions.map((v) => (
            <button
              key={v.id}
              className={`version-item${v.id === detail.id ? ' current' : ''}`}
              onClick={() => {
                setOpen(false)
                if (v.id !== detail.id) onSwitch(v.id)
              }}
            >
              <span className="version-title">
                {v.title || t.untitled}
                {v.id === detail.familyId && <em>{t.mostComplete}</em>}
              </span>
              <span className="version-meta">
                {t.prompts(v.promptCount)} · {dateTime(v.lastActivity, language)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const COLLAPSE_LINES = 16

/**
 * Reading position saved per session file: the first turn visible at the top and its offset from the top edge.
 * A pixel scrollTop would not survive reopening, because off-screen turn heights are only estimates.
 */
interface Anchor {
  turn: number
  offset: number
}

// `scroll2:` supersedes `scroll:` keys, which could hold positions the view scrolled to by itself.
const anchorKey = (id: string) => `scroll2:${id}`

function readAnchor(id: string): Anchor | null {
  try {
    const raw = localStorage.getItem(anchorKey(id))
    return raw ? (JSON.parse(raw) as Anchor) : null
  } catch {
    return null
  }
}

function writeAnchor(id: string, a: Anchor | null): void {
  try {
    if (a) localStorage.setItem(anchorKey(id), JSON.stringify(a))
    else localStorage.removeItem(anchorKey(id))
  } catch {
    /* storage unavailable */
  }
}

function captureAnchor(el: HTMLElement): Anchor | null {
  const top = el.getBoundingClientRect().top
  for (const n of el.querySelectorAll<HTMLElement>('[data-turn]')) {
    const r = n.getBoundingClientRect()
    if (r.bottom > top) return { turn: Number(n.dataset.turn), offset: r.top - top }
  }
  return null
}

/** Where the view holds itself while content is still settling: the bottom, or a saved reading position. */
type Pin = 'bottom' | Anchor

function applyPin(el: HTMLElement, pin: Pin): void {
  if (pin === 'bottom') {
    el.scrollTop = el.scrollHeight
    return
  }
  const node = el.querySelector<HTMLElement>(`[data-turn="${pin.turn}"]`)
  if (!node) {
    el.scrollTop = el.scrollHeight
    return
  }
  const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - pin.offset
  if (Math.abs(delta) > 1) el.scrollTop += delta
}

const NAV_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

export default memo(function ChatView({ detail, loading, hasSelection, focus, onPreviewDoc, onSwitchVersion }: Props) {
  const { language } = useLanguage()
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const turnsRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const shownId = useRef<string | null>(null)
  /**
   * Off-screen turns only have estimated heights (content-visibility), and highlighting and images keep
   * resizing content after the first layout. Until the user scrolls, the view re-applies this pin on every
   * size change instead of scrolling once and drifting off.
   */
  const pin = useRef<Pin | null>(null)
  /** Only positions the user scrolled to are saved, never ones the view moved to by itself. */
  const userMoved = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [lightbox, setLightbox] = useState<ImageData | null>(null)
  const [edge, setEdge] = useState({ top: true, bottom: true })
  const [hit, setHit] = useState<Hit | null>(null)
  const appliedFocus = useRef(0)
  const hasDetail = !!detail

  const pinTo = (p: Pin | null) => {
    pin.current = p
    const el = scrollRef.current
    if (el && p) applyPin(el, p)
  }

  useLayoutEffect(() => {
    if (!scrollRef.current || !detail) return
    if (focus && focus.seq !== appliedFocus.current && focus.fileId === detail.id) {
      appliedFocus.current = focus.seq
      shownId.current = detail.id
      userMoved.current = false
      const found = locateHit(detail.turns, focus)
      setHit(found)
      pinTo(found ? { turn: found.turn, offset: 80 } : (readAnchor(detail.id) ?? 'bottom'))
    } else if (shownId.current !== detail.id) {
      shownId.current = detail.id
      userMoved.current = false
      setHit(null)
      // No saved position means the user left it at the bottom (or never scrolled): open at the latest message.
      pinTo(readAnchor(detail.id) ?? 'bottom')
    } else if (atBottom.current) {
      // Live update while reading at the bottom: follow the new messages.
      pinTo('bottom')
    }
  }, [detail, focus])

  // Highlights the terms in the hit turn once it is rendered (unfolding takes a render), then moves the first
  // match a third of the way down. The pin keeps it there while heights settle, until the user scrolls.
  useEffect(() => {
    const el = scrollRef.current
    if (!hit || !el) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const node = el.querySelector<HTMLElement>(`[data-turn="${hit.turn}"]`)
        const ranges = node ? termRanges(node, hit.terms) : []
        if (!node || !ranges.length) return
        CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges))
        if (!pin.current) return
        const rel = ranges[0].getBoundingClientRect().top - node.getBoundingClientRect().top
        pinTo({ turn: hit.turn, offset: Math.min(80, el.clientHeight / 3 - rel) })
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      CSS.highlights.delete(HIGHLIGHT)
    }
  }, [hit])

  useEffect(() => {
    const el = scrollRef.current
    const turns = turnsRef.current
    if (!el || !turns) return
    const ro = new ResizeObserver(() => {
      if (pin.current) applyPin(el, pin.current)
    })
    ro.observe(turns)
    ro.observe(el)
    const release = () => {
      pin.current = null
      userMoved.current = true
    }
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (NAV_KEYS.has(e.key) && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'))) release()
    }
    // pointerdown also covers dragging the scrollbar and clicks that expand content.
    el.addEventListener('wheel', release, { passive: true })
    el.addEventListener('pointerdown', release)
    window.addEventListener('keydown', onKey)
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', release)
      el.removeEventListener('pointerdown', release)
      window.removeEventListener('keydown', onKey)
    }
  }, [hasDetail])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && detail) {
        e.preventDefault()
        // Find scrolls to matches itself; a held pin would pull the view back.
        pin.current = null
        userMoved.current = true
        setFindOpen(true)
      } else if (e.key === 'Escape' && lightbox) {
        setLightbox(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, lightbox])

  useEffect(() => {
    setFindOpen(false)
  }, [detail?.id])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottom.current = bottom
    const top = el.scrollTop < 80
    setEdge((p) => (p.top === top && p.bottom === bottom ? p : { top, bottom }))

    if (!userMoved.current || !detail) return
    const id = detail.id
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const node = scrollRef.current
      if (!node || shownId.current !== id) return
      writeAnchor(id, atBottom.current ? null : captureAnchor(node))
    }, 250)
  }

  if (!hasSelection) {
    return (
      <main className="chat empty">
        <div className="empty-title">{t.selectSession}</div>
        <div className="empty-hint">{t.emptyHint}</div>
      </main>
    )
  }

  if (!detail) {
    return (
      <main className="chat empty">
        <div className="empty-hint">{loading ? t.loading : t.unreadableSession}</div>
      </main>
    )
  }

  return (
    <main className="chat">
      {findOpen && <FindBar onClose={() => setFindOpen(false)} />}
      <div className={`chat-scroll${loading ? ' dim' : ''}`} ref={scrollRef} onScroll={onScroll}>
        <header className="chat-header">
          <div className="chat-meta">
            <span>
              {dateTime(detail.firstTime, language)} — {dateTime(detail.lastTime, language)}
            </span>
            {detail.versions.length > 1 && <VersionPicker detail={detail} onSwitch={onSwitchVersion} />}
          </div>
        </header>
        <div className="turns" ref={turnsRef}>
          {detail.turns.length === 0 && <div className="empty-hint">{t.noTurns}</div>}
          <TurnList
            key={detail.id}
            turns={detail.turns}
            base={detail.path}
            hitTurn={hit?.turn ?? -1}
            hitReveal={hit?.reveal ?? null}
            onPreviewDoc={onPreviewDoc}
            onImage={setLightbox}
          />
        </div>
      </div>

      <div className="scroll-btns">
        {!edge.top && (
          <button
            className="fab"
            title={t.scrollTop}
            onClick={() => {
              pin.current = null
              userMoved.current = true
              scrollRef.current?.scrollTo({ top: 0 })
            }}
          >
            <ArrowUp />
          </button>
        )}
        {!edge.bottom && (
          <button
            className="fab"
            title={t.scrollBottom}
            onClick={() => {
              if (!detail) return
              writeAnchor(detail.id, null)
              pinTo('bottom')
            }}
          >
            <ArrowDown />
          </button>
        )}
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={`data:${lightbox.mediaType};base64,${lightbox.data}`} alt="" />
          <button className="icon-btn lightbox-close" title={t.closeEsc}>
            <Close />
          </button>
        </div>
      )}
    </main>
  )
})

export const TurnList = memo(function TurnList({
  turns,
  base,
  hitTurn,
  hitReveal,
  onPreviewDoc,
  onImage,
}: {
  turns: Turn[]
  /** Project directory, for showing edited file paths relative to it */
  base: string
  /** Turn holding the opened search hit, -1 for none */
  hitTurn: number
  hitReveal: Reveal | null
  onPreviewDoc: PreviewDoc
  onImage: (i: ImageData) => void
}) {
  const { language } = useLanguage()
  // The header already shows the date range, so a divider only marks a date change inside the conversation.
  let prevDay = ''
  return (
    <>
      {turns.map((t, i) => {
        const day = t.time ? dayKey(t.time) : prevDay
        const showDay = !!t.time && !!prevDay && day !== prevDay
        prevDay = day
        return (
          <Fragment key={i}>
            {showDay && (
              <div className="day-sep">
                <span>{dayLabel(t.time, language)}</span>
              </div>
            )}
            <div data-turn={i}>
              <TurnView
                turn={t}
                base={base}
                reveal={i === hitTurn ? hitReveal : null}
                onPreviewDoc={onPreviewDoc}
                onImage={onImage}
              />
            </div>
          </Fragment>
        )
      })}
    </>
  )
})

const TurnView = memo(function TurnView({
  turn,
  base,
  reveal,
  onPreviewDoc,
  onImage,
}: {
  turn: Turn
  base: string
  reveal: Reveal | null
  onPreviewDoc: PreviewDoc
  onImage: (i: ImageData) => void
}) {
  const t = useT()
  switch (turn.kind) {
    case 'user':
      return <UserTurn turn={turn} reveal={reveal} onImage={onImage} />
    case 'assistant':
      return <AssistantTurn turn={turn} base={base} reveal={reveal} onPreviewDoc={onPreviewDoc} />
    case 'command':
      return (
        <div className="turn command">
          <code>{turn.text}</code>
        </div>
      )
    case 'compact':
      return (
        <div className="turn compact">
          <span>{t.compacted}</span>
        </div>
      )
    case 'resume':
      return (
        <div className="turn compact">
          <span>
            {turn.source === 'agent'
              ? t.resumeAgent(turn.agent || t.subagent)
              : turn.source === 'message'
                ? t.resumeMessage
                : turn.source === 'notification'
                  ? t.resumeNotification
                  : t.resumeOther}
          </span>
        </div>
      )
  }
})

/** Shows the final answer; commentary written between tool calls stays folded unless expanded. */
function AssistantTurn({
  turn,
  base,
  reveal,
  onPreviewDoc,
}: {
  turn: Extract<Turn, { kind: 'assistant' }>
  base: string
  reveal: Reveal | null
  onPreviewDoc: PreviewDoc
}) {
  const t = useT()
  const [showSteps, setShowSteps] = useState(false)
  useEffect(() => {
    if (reveal === 'steps') setShowSteps(true)
  }, [reveal])
  return (
    <div className="turn assistant">
      {turn.steps.length > 0 && (
        <div className={`steps${showSteps ? ' open' : ''}`}>
          <button className="steps-toggle" onClick={() => setShowSteps((v) => !v)}>
            <ChevronRight width={12} height={12} className="steps-chevron" />
            {t.steps(turn.steps.length)}
          </button>
          {showSteps && (
            <div className="steps-body">
              {turn.steps.map((s, i) => (
                <Markdown key={i} text={s} />
              ))}
            </div>
          )}
        </div>
      )}
      {turn.text && <Markdown text={turn.text} />}
      <DocEdits edits={turn.edits} base={base} onPreview={onPreviewDoc} />
      <div className="turn-actions">
        <CopyButton getText={() => turn.text} />
        <span className="turn-time">{clock(turn.time)}</span>
      </div>
    </div>
  )
}

function UserTurn({
  turn,
  reveal,
  onImage,
}: {
  turn: Extract<Turn, { kind: 'user' }>
  reveal: Reveal | null
  onImage: (i: ImageData) => void
}) {
  const t = useT()
  const lines = turn.text.split('\n').length
  const long = lines > COLLAPSE_LINES || turn.text.length > 1800
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (reveal) setExpanded(true)
  }, [reveal])
  return (
    <div className="turn user">
      <div className="bubble">
        {turn.images.length > 0 && (
          <div className="images">
            {turn.images.map((img, i) => (
              <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt="" onClick={() => onImage(img)} />
            ))}
          </div>
        )}
        {turn.text && <div className={`user-text${long && !expanded ? ' clamped' : ''}`}>{turn.text}</div>}
        {long && (
          <button className="expand-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? t.collapse : t.expandAll}
          </button>
        )}
      </div>
      <div className="turn-actions">
        <span className="turn-time">{clock(turn.time)}</span>
        <CopyButton getText={() => turn.text} />
      </div>
    </div>
  )
}
