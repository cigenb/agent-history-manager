import { useT } from '../i18n'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActionResult, LiveSessions, ProjectSummary, SearchHit, SessionSummary, UiState } from '../../../shared/types'
import type { Selection } from '../App'
import ContextMenu, { type MenuState } from './ContextMenu'
import { ChevronRight, Close, Folder, Search } from './Icons'
import SearchResults from './SearchResults'

interface Props {
  projects: ProjectSummary[] | null
  live: LiveSessions
  ui: UiState | null
  selected: Selection | null
  onSelect: (s: Selection) => void
  onUiChange: (patch: Partial<UiState>) => void
  onRenameSession: (projectKey: string, id: string, title: string) => Promise<ActionResult>
  onExportSession: (projectKey: string, session: SessionSummary) => Promise<void>
  onDeleteSession: (projectKey: string, s: SessionSummary) => void
  onOpenInTerminal: (projectKey: string, id: string) => void
  onOpenProjectInTerminal: (projectKey: string) => void
  onOpenMemory: (p: ProjectSummary) => void
  onDeleteProject: (p: ProjectSummary) => void
  onOpenSearchHit: (projectKey: string, id: string, hit: SearchHit | undefined, terms: string[]) => void
}

type LiveState = LiveSessions[string]

function LiveDot({ state }: { state: LiveState }) {
  const t = useT()
  return (
    <span
      className={`live-dot${state === 'busy' ? ' busy' : ''}`}
      title={state === 'busy' ? t.claudeBusy : t.sessionOpen}
    />
  )
}

const SOURCES = [
  ['claude', 'CC'],
  ['codex', 'Codex'],
  ['grok', 'Grok'],
] as const

/** Sessions shown per project before "显示更多" */
const PAGE = 8

/** Conversations the user has dragged keep their slots; new ones go on top, newest first. */
function applySessionOrder(sessions: SessionSummary[], order: string[] | undefined): SessionSummary[] {
  if (!order?.length) return sessions
  const pos = new Map(order.map((id, i) => [id, i]))
  const rank = (s: SessionSummary) => Math.min(...s.versions.map((v) => pos.get(v.id) ?? Infinity))
  const fresh = sessions.filter((s) => rank(s) === Infinity)
  const known = sessions.filter((s) => rank(s) !== Infinity).sort((a, b) => rank(a) - rank(b))
  return [...fresh, ...known]
}

// Small threshold so a plain click still selects instead of starting a drag.
function useDragSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
}

export default function Sidebar(props: Props) {
  const t = useT()
  const { projects, ui, selected, onSelect, onUiChange } = props
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** Row being renamed inline: `s:<projectKey>:<id>` */
  const [editing, setEditing] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sensors = useDragSensors()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tempMode = ui?.showTemp ?? false
  const source = ui?.source ?? 'claude'
  const expanded = useMemo(() => new Set(ui?.expanded ?? []), [ui?.expanded])
  const q = query.trim()

  const tempCount = useMemo(
    () =>
      (projects ?? []).reduce(
        (n, p) =>
          p.source !== source ? n : n + (p.isTemp ? p.sessions.length : p.sessions.filter((s) => s.headless).length),
        0,
      ),
    [projects, source],
  )

  const visible = useMemo(() => {
    if (!projects) return []
    return projects
      .filter((p) => p.source === source)
      .map((p) => {
        const inMode = (s: SessionSummary) => (p.isTemp || s.headless) === tempMode
        return { project: p, sessions: applySessionOrder(p.sessions, ui?.sessionOrder[p.key]).filter(inMode) }
      })
      .filter((x) => x.sessions.length > 0)
  }, [projects, tempMode, source, ui?.sessionOrder])

  // Handlers below are created once and read current values from this ref. Stable handlers let memo()
  // skip every project except the one that changed; otherwise expanding one project re-renders all rows.
  const latest = useRef({ projects, ui, props, expanded, t })
  latest.current = { projects, ui, props, expanded, t }

  const toggle = useCallback((key: string) => {
    const next = new Set(latest.current.expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    latest.current.props.onUiChange({ expanded: [...next] })
  }, [])

  const onProjectDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    const all = latest.current.projects
    if (!all || !over || active.id === over.id) return
    // Reorder within the full list so projects hidden by the current mode keep their slots.
    const keys = all.map((p) => p.key)
    const from = keys.indexOf(String(active.id))
    const to = keys.indexOf(String(over.id))
    if (from >= 0 && to >= 0) latest.current.props.onUiChange({ projectOrder: arrayMove(keys, from, to) })
  }, [])

  const onSessionDragEnd = useCallback((project: ProjectSummary, { active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const order = latest.current.ui?.sessionOrder
    const ids = applySessionOrder(project.sessions, order?.[project.key]).map((s) => s.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    latest.current.props.onUiChange({ sessionOrder: { ...order, [project.key]: arrayMove(ids, from, to) } })
  }, [])

  const projectMenu = useCallback((e: React.MouseEvent, p: ProjectSummary) => {
    e.preventDefault()
    const t = latest.current.t
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(p.path ? [{ label: t.openExplorer, onSelect: () => void window.api.openPath(p.path) }] : []),
        // Codex conversations are continued in Codex Desktop.
        ...(p.source !== 'codex'
          ? [{ label: t.openTerminal, onSelect: () => latest.current.props.onOpenProjectInTerminal(p.key) }]
          : []),
        // Grok keeps no per-project memory folder here.
        ...(p.source === 'claude'
          ? [{ label: p.memoryCount > 0 ? t.manageMemory : t.manageMemoryEmpty, onSelect: () => latest.current.props.onOpenMemory(p) }]
          : []),
        {
          label: t.deleteProject,
          danger: true,
          onSelect: () => latest.current.props.onDeleteProject(p),
        },
      ],
    })
  }, [])

  const sessionMenu = useCallback((e: React.MouseEvent, p: ProjectSummary, s: SessionSummary) => {
    e.preventDefault()
    const t = latest.current.t
    const isLive = s.versions.some((v) => latest.current.props.live[v.id])
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        // Codex content is not read, so there is nothing to export or resume here.
        ...(p.source !== 'codex' ? [{ label: t.exportMarkdown, onSelect: () => void latest.current.props.onExportSession(p.key, s) }] : []),
        ...(!isLive ? [
          ...(p.source !== 'codex' ? [{ label: t.openTerminal, onSelect: () => latest.current.props.onOpenInTerminal(p.key, s.id) }] : []),
          // Grok titles are set inside Grok (/rename).
          ...(p.source === 'claude' ? [{ label: t.rename, onSelect: () => setEditing(`s:${p.key}:${s.id}`) }] : []),
          { label: t.delete, danger: true, onSelect: () => latest.current.props.onDeleteSession(p.key, s) },
        ] : []),
      ],
    })
  }, [])

  const renameSession = useCallback(
    (projectKey: string, id: string, title: string) => latest.current.props.onRenameSession(projectKey, id, title),
    [],
  )
  const editDone = useCallback(() => setEditing(null), [])
  const projectKeys = useMemo(() => visible.map((v) => v.project.key), [visible])

  // Per project, a string like "id:busy,id:idle". A string compares by value, so a project whose
  // conversations did not change state keeps the same prop and is skipped by memo().
  const liveKeys = useMemo(() => {
    const out = new Map<string, string>()
    for (const { project } of visible) {
      const parts: string[] = []
      for (const s of project.sessions) {
        const states = s.versions.map((v) => props.live[v.id]).filter(Boolean)
        if (states.length) parts.push(`${s.id}:${states.includes('busy') ? 'busy' : 'idle'}`)
      }
      if (parts.length) out.set(project.key, parts.join(','))
    }
    return out
  }, [visible, props.live])

  return (
    <aside className="sidebar">
      <div className="source-switch" role="group" aria-label={t.historySource}>
        {SOURCES.map(([s, label]) => (
          <button key={s} aria-pressed={source === s} onClick={() => onUiChange({ source: s })}>
            {label}
          </button>
        ))}
      </div>
      <div className="search">
        <Search className="search-icon" />
        <input
          ref={searchRef}
          value={query}
          placeholder={t.searchSessions}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('')
          }}
        />
        {query && (
          <button className="icon-btn search-clear" onClick={() => setQuery('')} title={t.clear}>
            <Close width={14} height={14} />
          </button>
        )}
      </div>
      <div className="section-label">{q ? t.searchResults : tempMode ? t.tempSessions : t.projects}</div>
      <div className="project-list">
        {q && projects ? (
          <SearchResults
            query={q}
            temp={tempMode}
            source={source}
            projects={projects}
            selectedId={selected?.id ?? null}
            onOpen={props.onOpenSearchHit}
          />
        ) : (
          <>
            {!projects && <div className="sidebar-empty">{t.loadingSessions}</div>}
            {projects && visible.length === 0 && <div className="sidebar-empty">{t.noSessions}</div>}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onProjectDragEnd}>
              <SortableContext items={projectKeys} strategy={verticalListSortingStrategy}>
                {visible.map(({ project, sessions }) => (
                  <ProjectItem
                    key={project.key}
                    project={project}
                    sessions={sessions}
                    open={expanded.has(project.key)}
                    selectedId={selected?.projectKey === project.key ? selected.id : null}
                    liveKey={liveKeys.get(project.key) ?? ''}
                    // Only the project that owns the row being edited sees a value, so the others stay memoized.
                    editingId={editing?.startsWith(`s:${project.key}:`) ? editing.slice(project.key.length + 3) : null}
                    onToggle={toggle}
                    onSelect={onSelect}
                    onProjectMenu={projectMenu}
                    onSessionMenu={sessionMenu}
                    onSessionDragEnd={onSessionDragEnd}
                    onRenameSession={renameSession}
                    onStartEdit={setEditing}
                    onEditDone={editDone}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </>
        )}
      </div>

      {(tempCount > 0 || tempMode) && (
        <label className="sidebar-footer" title={t.tempHint}>
          <input type="checkbox" checked={tempMode} onChange={(e) => onUiChange({ showTemp: e.target.checked })} />
          {t.tempOnly(tempCount)}
        </label>
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}

function InlineEdit({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(ref.current?.value ?? '')
    else onCancel()
  }
  return (
    <input
      ref={ref}
      className="inline-edit"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}

interface ItemProps {
  project: ProjectSummary
  sessions: SessionSummary[]
  open: boolean
  selectedId: string | null
  /** "id:busy,id:idle" for this project's conversations open in Claude Code; empty when none */
  liveKey: string
  /** Id of this project's conversation being renamed inline */
  editingId: string | null
  onToggle: (key: string) => void
  onSelect: (s: Selection) => void
  onProjectMenu: (e: React.MouseEvent, p: ProjectSummary) => void
  onSessionMenu: (e: React.MouseEvent, p: ProjectSummary, s: SessionSummary) => void
  onSessionDragEnd: (p: ProjectSummary, e: DragEndEvent) => void
  onRenameSession: (projectKey: string, id: string, title: string) => Promise<ActionResult>
  onStartEdit: (key: string) => void
  onEditDone: () => void
}

const ProjectItem = memo(function ProjectItem(props: ItemProps) {
  const t = useT()
  const { project, sessions, open, selectedId, editingId, onSessionDragEnd, liveKey } = props
  const liveMap = useMemo(
    () => new Map(liveKey ? liveKey.split(',').map((p) => p.split(':') as [string, LiveState]) : []),
    [liveKey],
  )
  const projectLive: LiveState | undefined = liveKey ? (liveKey.includes(':busy') ? 'busy' : 'idle') : undefined
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.key })
  const sensors = useDragSensors()
  const [limit, setLimit] = useState(PAGE)
  // Keep the open conversation visible even when it sits past the current page.
  const selectedIndex = selectedId ? sessions.findIndex((s) => s.id === selectedId) : -1
  const shown = Math.max(limit, selectedIndex + 1)
  const visibleSessions = useMemo(() => sessions.slice(0, shown), [sessions, shown])
  const sessionIds = useMemo(() => visibleSessions.map((s) => s.id), [visibleSessions])
  const hidden = sessions.length - visibleSessions.length
  const onDragEnd = useCallback((e: DragEndEvent) => onSessionDragEnd(project, e), [onSessionDragEnd, project])

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition,
    zIndex: isDragging ? 2 : undefined,
  }

  return (
    <div ref={setNodeRef} style={style} className={`project${isDragging ? ' dragging' : ''}`}>
      <div
        className="project-row"
        title={project.path}
        {...attributes}
        {...listeners}
        onClick={() => props.onToggle(project.key)}
        onContextMenu={(e) => props.onProjectMenu(e, project)}
      >
        <ChevronRight className={`chevron${open ? ' open' : ''}`} width={14} height={14} />
        <Folder className="folder" width={16} height={16} />
        <span className="project-name">{project.projectless ? t.noProject : project.name}</span>
        {/* Collapsed projects still show that one of their conversations is running. */}
        {!open && projectLive && <LiveDot state={projectLive} />}
        <span className="count">{sessions.length}</span>
      </div>
      {open && (
        <div className="session-list">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={sessionIds} strategy={verticalListSortingStrategy}>
              {visibleSessions.map((s) => (
                <SessionRow
                  key={s.id}
                  project={project}
                  session={s}
                  active={s.id === selectedId}
                  live={liveMap.get(s.id)}
                  editing={editingId === s.id}
                  onSelect={props.onSelect}
                  onMenu={props.onSessionMenu}
                  onRename={props.onRenameSession}
                  onStartEdit={props.onStartEdit}
                  onEditDone={props.onEditDone}
                />
              ))}
            </SortableContext>
          </DndContext>
          {(hidden > 0 || limit > PAGE) && (
            <div className="more-row">
              {hidden > 0 && (
                <button className="more-btn" onClick={() => setLimit((n) => n + PAGE)}>
                  {t.showMore(hidden)}
                </button>
              )}
              {limit > PAGE && (
                <button className="more-btn" onClick={() => setLimit(PAGE)}>
                  {t.collapse}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

const SessionRow = memo(function SessionRow({
  project,
  session: s,
  active,
  live,
  editing,
  onSelect,
  onMenu,
  onRename,
  onStartEdit,
  onEditDone,
}: {
  project: ProjectSummary
  session: SessionSummary
  active: boolean
  /** Set while the conversation is open in Claude Code; rename and delete are unavailable then */
  live: LiveState | undefined
  editing: boolean
  onSelect: (s: Selection) => void
  onMenu: (e: React.MouseEvent, p: ProjectSummary, s: SessionSummary) => void
  onRename: (projectKey: string, id: string, title: string) => Promise<ActionResult>
  onStartEdit: (key: string) => void
  onEditDone: () => void
}) {
  const t = useT()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: s.id,
    disabled: editing,
  })
  const [pending, setPending] = useState<string | null>(null)
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition,
    zIndex: isDragging ? 2 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`session-row${active ? ' active' : ''}${isDragging ? ' dragging' : ''}`}
      title={s.title || t.untitled}
      {...attributes}
      {...listeners}
      onClick={() => !editing && onSelect({ projectKey: project.key, id: s.id })}
      onDoubleClick={() => !live && project.source === 'claude' && onStartEdit(`s:${project.key}:${s.id}`)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e, project, s)
      }}
    >
      {live && <LiveDot state={live} />}
      {editing ? (
        <InlineEdit
          initial={s.title || t.untitled}
          onCommit={(v) => {
            onEditDone()
            if (!v.trim() || v.trim() === (s.title || t.untitled)) return
            setPending(v.trim())
            void onRename(project.key, s.id, v).finally(() => setPending(null))
          }}
          onCancel={onEditDone}
        />
      ) : (
        <span className="session-title">{pending ?? (s.title || t.untitled)}</span>
      )}
      {s.archived && <span className="origin-badge">{t.archived}</span>}
      {s.origin && (
        <span className="origin-badge" title={s.origin.client === 'claude' ? t.originBadgeClaude : t.originBadgeCodex}>
          {s.origin.client === 'claude' ? 'Claude' : 'Codex'}
        </span>
      )}
    </div>
  )
})
