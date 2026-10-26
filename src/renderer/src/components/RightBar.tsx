import { useT } from '../i18n'
import type { Dictionary } from '../i18n/zh'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentDetail, AgentRun, DocEdit, DocFile, LiveSessions, McpUse, SessionDetail, SessionLink, Turn } from '../../../shared/types'
import { TurnList } from './ChatView'
import { displayPath, type PreviewDoc } from './DocEditCard'
import { ChevronLeft, ChevronRight } from './Icons'
import Markdown, { type LineMark } from './Markdown'
import { lineDiff } from '../lib/diff'

/** What the right panel shows: the session's subagents and MCP calls, one subagent, or a Markdown file. */
export type PanelView =
  | { kind: 'activity' }
  | { kind: 'agent'; id: string }
  /** `seq` changes on every click, so previewing another turn's changes of the same file starts over */
  | { kind: 'doc'; path: string; hunks: DocEdit['hunks']; seq: number }

export type LiveState = LiveSessions[string] | undefined

interface Props {
  detail: SessionDetail | null
  /** Set while the shown session file is open in Claude Code: unfinished subagents and MCP calls are running */
  live: LiveState
  view: PanelView
  onView: (view: PanelView) => void
  onPreviewDoc: PreviewDoc
  /** Opens a linked conversation, switching the sidebar to its history */
  onOpenSession: (link: SessionLink) => void
}

// Subagent prompts are plain text from the Agent tool's input, so their transcripts carry no images.
const noImage = () => {}

/** Unfinished work is running only while the session is open; otherwise it was cut off. */
function agentStatus(run: AgentRun, live: LiveState, t: Dictionary): { cls: string; label: string } {
  if (run.state === 'done') return { cls: 'done', label: t.agentDone }
  if (run.state === 'stopped') return { cls: 'stopped', label: t.agentStopped }
  return live ? { cls: 'running', label: t.agentRunning } : { cls: 'unfinished', label: t.agentUnfinished }
}

function agentMeta(run: AgentRun, t: Dictionary): string {
  return [run.type, run.model, run.toolCalls ? t.toolCalls(run.toolCalls) : null].filter(Boolean).join(' · ')
}

/** Subagents newest first, and MCP tools merged across the turns: a call still waiting outranks a failure. */
function collectActivity(turns: Turn[]): { agents: AgentRun[]; mcp: McpUse[] } {
  const agents: AgentRun[] = []
  const mcp = new Map<string, McpUse>()
  for (const turn of turns) {
    if (turn.kind !== 'assistant') continue
    agents.push(...turn.agents)
    for (const m of turn.mcp) {
      const key = `${m.server}/${m.tool}`
      const same = mcp.get(key)
      if (!same) mcp.set(key, { ...m })
      else {
        same.count += m.count
        if (m.state === 'open' || (m.state === 'error' && same.state === 'done')) same.state = m.state
      }
    }
  }
  return { agents: agents.reverse(), mcp: [...mcp.values()] }
}

function AgentRow({ run, live, onOpen }: { run: AgentRun; live: LiveState; onOpen: (id: string) => void }) {
  const t = useT()
  const status = agentStatus(run, live, t)
  const id = run.id
  return (
    <button
      className="agent-row"
      disabled={!id}
      title={id ? t.openAgent : t.agentMissing}
      onClick={() => {
        if (id) onOpen(id)
      }}
    >
      <span className="agent-row-main">
        <span className="agent-row-title">{run.description || t.subagent}</span>
        <span className="agent-row-meta">{agentMeta(run, t)}</span>
      </span>
      <span className={`agent-status ${status.cls}`}>{status.label}</span>
      {id && <ChevronRight width={14} height={14} className="agent-row-chevron" />}
    </button>
  )
}

function McpRow({ use, live }: { use: McpUse; live: LiveState }) {
  const t = useT()
  const cls = use.state === 'open' ? (live ? 'running' : 'unfinished') : use.state
  const label =
    use.state === 'error' ? t.mcpFailed : use.state === 'open' ? (live ? t.mcpRunning : t.mcpNoResult) : t.agentDone
  return (
    <div className="mcp-row">
      <span className="mcp-row-name">
        <span className="mcp-server">{use.server}</span>
        <span className="mcp-tool">{use.tool}</span>
        {use.count > 1 && <span className="mcp-count">×{use.count}</span>}
      </span>
      <span className={`agent-status ${cls}`}>{label}</span>
    </div>
  )
}

function ActivityLists({
  turns,
  live,
  onOpenAgent,
}: {
  turns: Turn[]
  live: LiveState
  onOpenAgent: (id: string) => void
}) {
  const t = useT()
  const { agents, mcp } = useMemo(() => collectActivity(turns), [turns])
  if (!agents.length && !mcp.length) return null
  return (
    <div className="activity-lists">
      {agents.length > 0 && (
        <section>
          <div className="rightbar-section">
            {t.subagents} <span className="count">{agents.length}</span>
          </div>
          {agents.map((a, i) => (
            <AgentRow key={i} run={a} live={live} onOpen={onOpenAgent} />
          ))}
        </section>
      )}
      {mcp.length > 0 && (
        <section>
          <div className="rightbar-section">MCP</div>
          {mcp.map((m) => (
            <McpRow key={`${m.server}/${m.tool}`} use={m} live={live} />
          ))}
        </section>
      )}
    </div>
  )
}

function LinkRow({ title, meta, onOpen }: { title: string; meta: string; onOpen?: () => void }) {
  const t = useT()
  return (
    <button className="agent-row" disabled={!onOpen} title={onOpen ? t.openLinked : undefined} onClick={onOpen}>
      <span className="agent-row-main">
        <span className="agent-row-title">{title}</span>
        <span className="agent-row-meta">{meta}</span>
      </span>
      {onOpen && <ChevronRight width={14} height={14} className="agent-row-chevron" />}
    </button>
  )
}

/** Grok-MCP links: the conversation that dispatched this Grok session, or the Grok sessions this one dispatched. */
function SessionLinks({ detail, onOpen }: { detail: SessionDetail; onOpen: (link: SessionLink) => void }) {
  const t = useT()
  const { origin, originSession, dispatched } = detail
  if (!origin && !dispatched?.length) return null
  return (
    <div className="activity-lists">
      {origin && (
        <section>
          <div className="rightbar-section">{t.origin}</div>
          {originSession ? (
            <LinkRow title={originSession.title || t.untitled} meta="Claude Code" onOpen={() => onOpen(originSession)} />
          ) : origin.client === 'claude' ? (
            <LinkRow title="Claude Code" meta={t.originClaudeMissing} />
          ) : (
            <LinkRow title={t.originCodex} meta={origin.owner} />
          )}
        </section>
      )}
      {!!dispatched?.length && (
        <section>
          <div className="rightbar-section">
            {t.dispatchedGrok} <span className="count">{dispatched.length}</span>
          </div>
          {dispatched.map((l) => (
            <LinkRow key={l.id} title={l.title || t.untitled} meta="Grok" onOpen={() => onOpen(l)} />
          ))}
        </section>
      )}
    </div>
  )
}

function Header({ title, sub, onBack }: { title: string; sub?: React.ReactNode; onBack?: () => void }) {
  const t = useT()
  return (
    <header className="rightbar-head">
      {onBack && (
        <button className="icon-btn" title={t.back} onClick={onBack}>
          <ChevronLeft width={16} height={16} />
        </button>
      )}
      <div className="rightbar-titles">
        <div className="rightbar-title">{title}</div>
        {sub && <div className="rightbar-sub">{sub}</div>}
      </div>
    </header>
  )
}

/**
 * A subagent's conversation. Opens at its final reply when it is done, or follows the bottom while it runs.
 * Reloads with the session: changes to subagent transcripts trigger a session reload.
 */
function AgentView({
  detail,
  agentId,
  live,
  onView,
  onPreviewDoc,
}: {
  detail: SessionDetail
  agentId: string
  live: LiveState
  onView: (view: PanelView) => void
  onPreviewDoc: PreviewDoc
}) {
  const t = useT()
  const [data, setData] = useState<AgentDetail | null | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** Same idea as the conversation's pin: held until the user scrolls, re-applied as heights settle. */
  const pin = useRef<'bottom' | number | null>(null)
  const placed = useRef(false)

  useEffect(() => {
    let active = true
    void window.api.loadAgent(detail.projectKey, detail.id, agentId).then((d) => {
      if (active) setData(d)
    })
    return () => {
      active = false
    }
  }, [detail, agentId])

  const apply = () => {
    const el = bodyRef.current
    const p = pin.current
    if (!el || p === null) return
    if (p === 'bottom') {
      el.scrollTop = el.scrollHeight
      return
    }
    const node = el.querySelector<HTMLElement>(`[data-turn="${p}"]`)
    if (node) el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 12
  }

  useLayoutEffect(() => {
    if (!data || placed.current) return
    placed.current = true
    pin.current = data.run.state === 'open' ? 'bottom' : data.turns.length - 1
    apply()
  }, [data])

  useEffect(() => {
    const el = bodyRef.current
    const content = contentRef.current
    if (!el || !content) return
    const ro = new ResizeObserver(apply)
    ro.observe(content)
    const release = () => {
      pin.current = null
    }
    el.addEventListener('wheel', release, { passive: true })
    el.addEventListener('pointerdown', release)
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', release)
      el.removeEventListener('pointerdown', release)
    }
  }, [])

  const run = data?.run
  const openAgent = (id: string) => onView({ kind: 'agent', id })
  return (
    <>
      <Header
        title={run?.description || t.subagent}
        sub={run && `${agentMeta(run, t)} · ${agentStatus(run, live, t).label}`}
        onBack={() => onView({ kind: 'activity' })}
      />
      <div
        className="rightbar-body"
        ref={bodyRef}
        onScroll={() => {
          // Back at the bottom of a running subagent: follow it again.
          const el = bodyRef.current
          if (el && pin.current === null && run?.state === 'open' && el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
            pin.current = 'bottom'
          }
        }}
      >
        <div className="turns" ref={contentRef}>
          {data === undefined && <div className="empty-hint">{t.loading}</div>}
          {data === null && <div className="empty-hint">{t.agentMissing}</div>}
          {data && (
            <>
              <ActivityLists turns={data.turns} live={live} onOpenAgent={openAgent} />
              <TurnList
                turns={data.turns}
                base={detail.path}
                hitTurn={-1}
                hitReveal={null}
                onPreviewDoc={onPreviewDoc}
                onImage={noImage}
              />
            </>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Marks per line of a replacement's new text, from a line diff against its old text: within each run of
 * changes, new lines paired with removed ones are modified, the extra ones added; unchanged lines get none.
 */
function newLineMarks(oldText: string, newText: string): (LineMark | undefined)[] {
  const out: (LineMark | undefined)[] = []
  let removed = 0
  for (const l of lineDiff(oldText, newText)) {
    if (l.type === '-') removed++
    else if (l.type === '+') {
      out.push(removed > 0 ? 'modified' : 'added')
      if (removed > 0) removed--
    } else {
      out.push(undefined)
      removed = 0
    }
  }
  return out
}

/** Changed lines of `content` for each replacement found in it; replacements no longer found are counted. */
function changedLines(content: string, hunks: DocEdit['hunks']): { marks: Map<number, LineMark>; missing: number } {
  const marks = new Map<number, LineMark>()
  let missing = 0
  const lineAt = (i: number) => content.slice(0, i).split('\n').length
  for (const h of hunks) {
    const text = h.new.replace(/\r\n/g, '\n')
    // A pure deletion leaves nothing to show.
    if (!text.trim()) continue
    const lineMarks = newLineMarks(h.old.replace(/\r\n/g, '\n'), text)
    let found = false
    for (let at = content.indexOf(text); at !== -1; at = content.indexOf(text, at + text.length)) {
      found = true
      const first = lineAt(at)
      lineMarks.forEach((mark, i) => {
        if (mark && marks.get(first + i) !== 'modified') marks.set(first + i, mark)
      })
    }
    if (!found) missing++
  }
  return { marks, missing }
}

/** A Markdown file as it is now, with the turn's changes highlighted; the path opens its folder. */
function DocView({
  detail,
  view,
  onBack,
}: {
  detail: SessionDetail
  view: Extract<PanelView, { kind: 'doc' }>
  onBack: () => void
}) {
  const t = useT()
  const [file, setFile] = useState<DocFile | null | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)

  // Re-read on every session reload: Claude may edit the file again while it is shown.
  useEffect(() => {
    let active = true
    void window.api.readMarkdown(view.path, detail.path).then((f) => {
      if (active) setFile(f)
    })
    return () => {
      active = false
    }
  }, [view.path, detail])

  const content = useMemo(() => file?.content.replace(/\r\n/g, '\n') ?? '', [file])
  const { marks, missing } = useMemo(() => changedLines(content, view.hunks), [content, view.hunks])

  // Brings the first change into view once, after the first render of the file.
  useEffect(() => {
    if (!file || scrolled.current) return
    scrolled.current = true
    bodyRef.current?.querySelector('.md-added, .md-modified')?.scrollIntoView({ block: 'center' })
  }, [file])

  const { name } = displayPath(view.path, detail.path)
  return (
    <>
      <Header title={name} onBack={onBack} />
      {file && (
        <div className="doc-view-bar">
          <button className="doc-view-path" title={t.showInFolder} onClick={() => void window.api.showInFolder(file.path)}>
            {file.path}
          </button>
          <div className="doc-view-legend">
            <span className="legend added">{t.legendAdded}</span>
            <span className="legend modified">{t.legendModified}</span>
            {missing > 0 && <span className="doc-view-missing">{t.changesNotFound(missing)}</span>}
          </div>
        </div>
      )}
      <div className="rightbar-body" ref={bodyRef}>
        <div className="doc-view-content">
          {file === undefined && <div className="empty-hint">{t.loading}</div>}
          {file === null && <div className="empty-hint">{t.docUnreadable}</div>}
          {file && <Markdown text={content} marks={marks} />}
        </div>
      </div>
    </>
  )
}

/** Right panel beside the conversation; its top strip sits under the window controls (see App). */
export default memo(function RightBar({ detail, live, view, onView, onPreviewDoc, onOpenSession }: Props) {
  const t = useT()
  const openAgent = (id: string) => onView({ kind: 'agent', id })
  return (
    <aside className="rightbar">
      {!detail ? (
        <div className="rightbar-idle">{t.rightbarIdle}</div>
      ) : view.kind === 'agent' ? (
        <AgentView key={view.id} detail={detail} agentId={view.id} live={live} onView={onView} onPreviewDoc={onPreviewDoc} />
      ) : view.kind === 'doc' ? (
        <DocView key={view.seq} detail={detail} view={view} onBack={() => onView({ kind: 'activity' })} />
      ) : (
        <>
          <Header title={t.activity} />
          <div className="rightbar-body">
            <SessionLinks detail={detail} onOpen={onOpenSession} />
            <ActivityLists turns={detail.turns} live={live} onOpenAgent={openAgent} />
            {!detail.origin && !detail.dispatched?.length && !detail.turns.some((x) => x.kind === 'assistant' && (x.agents.length || x.mcp.length)) && (
              <div className="rightbar-empty">{t.noActivity}</div>
            )}
          </div>
        </>
      )}
    </aside>
  )
})
