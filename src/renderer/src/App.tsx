import { LANGUAGE_LABELS, useT, translateError, useLanguage } from './i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeleteKind, DeleteTarget, DocEdit, LiveSessions, ProjectSummary, SearchHit, SessionDetail, SessionSummary, UiState } from '../../shared/types'
import ChatView, { type SearchFocus } from './components/ChatView'
import DeleteDialog, { type DeleteRequest } from './dialogs/DeleteDialog'
import { Download, PanelLeft, PanelRight } from './components/Icons'
import RightBar, { type PanelView } from './components/RightBar'
import MemoryPanel from './memory/MemoryPanel'
import { CopyButton } from './components/Markdown'
import Sidebar from './components/Sidebar'
import { exportMarkdown, markdownFileName } from './lib/exportMarkdown'

export interface Selection {
  projectKey: string
  id: string
}

const SIDEBAR_KEY = 'sidebarWidth'
const COLLAPSED_KEY = 'sidebarCollapsed'
const RIGHTBAR_KEY = 'rightbarWidth'
const RIGHTBAR_OPEN_KEY = 'rightbarOpen'
const SIDEBAR_RANGE = [220, 520] as const
const RIGHTBAR_RANGE = [320, 760] as const

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

function readWidth(key: string, [min, max]: readonly [number, number], fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key))
    return n >= min && n <= max ? n : fallback
  } catch {
    return fallback
  }
}

/** New projects (not yet in the saved order) go on top, newest first, like Claude Desktop. */
function applyOrder(projects: ProjectSummary[], order: string[]): ProjectSummary[] {
  const byKey = new Map(projects.map((p) => [p.key, p]))
  const known = new Set(order)
  const fresh = projects.filter((p) => !known.has(p.key))
  const ordered = order.map((k) => byKey.get(k)).filter((p): p is ProjectSummary => !!p)
  return [...fresh, ...ordered]
}

export default function App() {
  const t = useT()
  const { language, setLanguage } = useLanguage()
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [ui, setUi] = useState<UiState | null>(null)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => readWidth(SIDEBAR_KEY, SIDEBAR_RANGE, 300))
  const [collapsed, setCollapsed] = useState(() => readFlag(COLLAPSED_KEY))
  const [rightWidth, setRightWidth] = useState(() => readWidth(RIGHTBAR_KEY, RIGHTBAR_RANGE, 420))
  const [rightOpen, setRightOpen] = useState(() => readFlag(RIGHTBAR_OPEN_KEY))
  const [panelView, setPanelView] = useState<PanelView>({ kind: 'activity' })

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      writeFlag(COLLAPSED_KEY, !c)
      return !c
    })
  }, [])

  const showRightbar = useCallback((open: boolean) => {
    setRightOpen(open)
    writeFlag(RIGHTBAR_OPEN_KEY, open)
  }, [])

  const openPanel = useCallback(
    (view: PanelView) => {
      setPanelView(view)
      showRightbar(true)
    },
    [showRightbar],
  )

  const previewDoc = useCallback(
    (path: string, hunks: DocEdit['hunks']) => openPanel({ kind: 'doc', path, hunks, seq: Date.now() }),
    [openPanel],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])
  const selectedRef = useRef<Selection | null>(null)
  const loadSeq = useRef(0)

  const refresh = useCallback(async () => {
    const list = await window.api.listProjects()
    setProjects(list)
    return list
  }, [])

  useEffect(() => {
    void window.api.getUiState().then(setUi)
    void refresh()
  }, [refresh])

  /** Version currently shown for the selected conversation; null means its primary file. */
  const versionRef = useRef<string | null>(null)

  const load = useCallback(async (sel: Selection, background = false) => {
    const seq = ++loadSeq.current
    if (!background) setLoadingDetail(true)
    const d = await window.api.loadSession(sel.projectKey, versionRef.current ?? sel.id)
    if (seq !== loadSeq.current) return
    setDetail(d)
    setLoadingDetail(false)
  }, [])

  const [focus, setFocus] = useState<SearchFocus | null>(null)

  const switchVersion = useCallback(
    (id: string) => {
      const sel = selectedRef.current
      if (!sel) return
      versionRef.current = id === sel.id ? null : id
      setFocus(null)
      setPanelView({ kind: 'activity' })
      void load(sel)
    },
    [load],
  )

  // A subagent of the shown session file made progress: reload so its card and side panel update.
  useEffect(() => {
    return window.api.onAgentsChanged((sessionId) => {
      const sel = selectedRef.current
      if (sel && (versionRef.current ?? sel.id) === sessionId) void load(sel, true)
    })
  }, [load])

  // Live updates: re-index on file changes and reload the open session if it grew.
  useEffect(() => {
    return window.api.onProjectsChanged(async () => {
      const before = projects
      const list = await refresh()
      const sel = selectedRef.current
      if (!sel) return
      const find = (ps: ProjectSummary[] | null) =>
        ps?.find((p) => p.key === sel.projectKey)?.sessions.find((s) => s.id === sel.id || s.versions.some((v) => v.id === sel.id))
      const prev = find(before)
      const next = find(list)
      if (next && (next.id !== sel.id || !prev || prev.familyActivity !== next.familyActivity || prev.title !== next.title)) {
        const current = { projectKey: sel.projectKey, id: next.id }
        if (next.id !== sel.id) {
          selectedRef.current = current
          setSelected(current)
          if (versionRef.current === next.id) versionRef.current = null
        }
        void load(current, true)
      }
    })
  }, [projects, refresh, load])

  /**
   * With a search focus, opens the version holding the hit and ChatView scrolls to it once that file is shown.
   * Every other open clears the focus, so a hit whose load was superseded cannot fire on a later open.
   */
  const select = useCallback(
    (sel: Selection, focus: SearchFocus | null = null) => {
      selectedRef.current = sel
      versionRef.current = focus && focus.fileId !== sel.id ? focus.fileId : null
      setSelected(sel)
      setFocus(focus)
      setPanelView({ kind: 'activity' })
      void load(sel)
    },
    [load],
  )

  const openSearchHit = useCallback(
    (projectKey: string, id: string, hit: SearchHit | undefined, terms: string[]) =>
      select({ projectKey, id }, hit ? { fileId: hit.fileId, needle: hit.needle, terms, seq: Date.now() } : null),
    [select],
  )

  const updateUi = useCallback((patch: Partial<UiState>) => {
    setUi((u) => (u ? { ...u, ...patch } : u))
    void window.api.setUiState(patch)
  }, [])

  const [live, setLive] = useState<LiveSessions>({})
  useEffect(() => {
    void window.api.getLiveSessions().then(setLive)
    return window.api.onLiveSessionsChanged(setLive)
  }, [])

  const [memoryProject, setMemoryProject] = useState<ProjectSummary | null>(null)

  /** The conversation containing a session file id, for jumping from a memory to where it was written. */
  const findSessionById = useCallback(
    (sessionId: string) => {
      for (const p of projects ?? []) {
        const s = p.sessions.find((x) => x.versions.some((v) => v.id === sessionId))
        if (s) return { projectKey: p.key, id: s.id }
      }
      return null
    },
    [projects],
  )

  const [toast, setToast] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null)

  const saveConversation = useCallback(async (conversation: SessionDetail, title: string) => {
    try {
      const result = await window.api.saveMarkdown(markdownFileName(title), exportMarkdown(conversation, title))
      if (!result.canceled) setToast(result.ok ? t.exportSuccess : translateError(t, result.error, t.exportFailed))
    } catch {
      setToast(t.exportFailed)
    }
  }, [t])

  const exportSession = useCallback(async (projectKey: string, session: SessionSummary) => {
    try {
      const conversation = await window.api.loadSession(projectKey, session.id)
      if (!conversation) { setToast(t.unreadableSession); return }
      await saveConversation(conversation, session.title || t.untitled)
    } catch {
      setToast(t.exportFailed)
    }
  }, [saveConversation, t])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])

  const renameSession = useCallback(
    async (projectKey: string, id: string, title: string) => {
      const r = await window.api.renameSession(projectKey, id, title)
      if (!r.ok) setToast(translateError(t, r.error, t.renameFailed))
      await refresh()
      const sel = selectedRef.current
      if (sel?.projectKey === projectKey && sel.id === id) void load(sel, true)
      return r
    },
    [refresh, load, t],
  )

  const confirmDelete = useCallback(
    async (target: DeleteTarget, kinds: DeleteKind[]) => {
      try {
        const r = await window.api.runDelete(target, kinds)
        setDeleting(null)
        if (!r.ok) setToast(translateError(t, r.error, t.deleteFailed))
        const sel = selectedRef.current
        // The open conversation only disappears if its session records were among the chosen kinds.
        const removed =
          kinds.includes('sessions') &&
          sel &&
          sel.projectKey === target.projectKey &&
          (target.kind === 'project' || target.id === sel.id)
        if (removed) {
          selectedRef.current = null
          setSelected(null)
          setDetail(null)
        }
      } catch (e) {
        setDeleting(null)
        setToast((e as Error).message)
      }
      // Refresh either way: a failed run may still have removed some of the files.
      await refresh()
    },
    [refresh, t],
  )

  // Depends on projectOrder only: other ui changes (expanding a project) must keep this array identical,
  // or every sidebar row re-renders.
  const projectOrder = ui?.projectOrder
  const ordered = useMemo(
    () => (projects && projectOrder ? applyOrder(projects, projectOrder) : null),
    [projects, projectOrder],
  )

  /** Drags the left sidebar's right edge, or the right panel's left edge (which grows when dragged left). */
  const startResize = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const [min, max] = side === 'left' ? SIDEBAR_RANGE : RIGHTBAR_RANGE
    const startW = side === 'left' ? sidebarWidth : rightWidth
    const setW = side === 'left' ? setSidebarWidth : setRightWidth
    let w = startW
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      w = Math.min(max, Math.max(min, side === 'left' ? startW + dx : startW - dx))
      setW(w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      try {
        localStorage.setItem(side === 'left' ? SIDEBAR_KEY : RIGHTBAR_KEY, String(w))
      } catch {
        /* storage unavailable */
      }
    }
    document.body.classList.add('resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const currentTitle =
    selected && projects
      ? projects.find((p) => p.key === selected.projectKey)?.sessions.find((s) => s.id === selected.id)?.title
      : undefined

  return (
    <div
      className={`app${collapsed ? ' sidebar-collapsed' : ''}${rightOpen ? ' rightbar-open' : ''}`}
      style={{ '--sidebar-w': `${sidebarWidth}px`, '--rightbar-w': `${rightWidth}px` } as React.CSSProperties}
    >
      <div className="titlebar">
        <div className="titlebar-side">
          <button
            className="icon-btn sidebar-toggle"
            onClick={toggleSidebar}
            title={collapsed ? t.expandSidebar : t.collapseSidebar}
          >
            <PanelLeft width={16} height={16} />
          </button>
          <span className="app-name">CC History Manager</span>
        </div>
        <div className="titlebar-main">
          {selected && <span className="titlebar-title">{currentTitle || t.untitled}</span>}
          {detail && selected && detail.familyId === selected.id && (
            <div className="titlebar-actions">
              <CopyButton getText={() => detail.id} label={t.copySessionId} iconRight />
              <button
                className="icon-btn"
                title={t.exportMarkdown}
                aria-label={t.exportMarkdown}
                onClick={() => void saveConversation(detail, detail.versions.find((v) => v.id === detail.id)?.title || t.untitled)}
              >
                <Download width={14} height={14} />
              </button>
            </div>
          )}
          <div className="language-switch" role="group" aria-label={t.language}>
            <button lang="en" aria-label={t.english} aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>{LANGUAGE_LABELS.en}</button>
            <button lang="zh-CN" aria-label={t.chinese} aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')}>{LANGUAGE_LABELS.zh}</button>
          </div>
          <button
            className="icon-btn rightbar-toggle"
            aria-pressed={rightOpen}
            title={rightOpen ? t.hideRightbar : t.showRightbar}
            onClick={() => showRightbar(!rightOpen)}
          >
            <PanelRight width={16} height={16} />
          </button>
        </div>
        {/* The right panel's top strip: the window controls are drawn over it, so the panel reaches the top edge. */}
        {rightOpen && <div className="titlebar-right" />}
      </div>
      <div className="body">
        <Sidebar
          projects={ordered}
          live={live}
          ui={ui}
          selected={selected}
          onSelect={select}
          onUiChange={updateUi}
          onRenameSession={renameSession}
          onExportSession={exportSession}
          onDeleteSession={(projectKey, s) =>
            setDeleting({
              target: { kind: 'session', projectKey, id: s.id },
              name: s.title || t.untitled,
              detail: s.versions.length > 1 ? t.deleteVersions(s.versions.length) : undefined,
            })
          }
          onOpenInTerminal={(projectKey, id) =>
            void window.api.openInTerminal(projectKey, id).then((r) => {
              if (!r.ok) setToast(translateError(t, r.error, t.terminalFailed))
            })
          }
          onOpenMemory={setMemoryProject}
          onOpenSearchHit={openSearchHit}
          onDeleteProject={(p) =>
            setDeleting({
              target: { kind: 'project', projectKey: p.key },
              name: p.name,
              detail: `${p.path} · ${t.conversations(p.sessions.length)}`,
              sessionTitles: p.sessions.map((s) => s.title || t.untitled),
            })
          }
        />
        <div className="resizer" onPointerDown={startResize('left')} />
        <ChatView
          detail={detail}
          loading={loadingDetail}
          hasSelection={!!selected}
          focus={focus}
          onPreviewDoc={previewDoc}
          onSwitchVersion={switchVersion}
        />
        {rightOpen && (
          <>
            <div className="resizer right" onPointerDown={startResize('right')} />
            <RightBar
              detail={detail}
              live={detail ? live[detail.id] : undefined}
              view={panelView}
              onView={setPanelView}
              onPreviewDoc={previewDoc}
            />
          </>
        )}
      </div>
      {deleting && <DeleteDialog request={deleting} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />}
      {memoryProject && (
        <MemoryPanel
          project={memoryProject}
          findSession={findSessionById}
          onOpenSession={(projectKey, id) => {
            // Expand the target project so the opened conversation is visible in the sidebar.
            if (ui && !ui.expanded.includes(projectKey)) updateUi({ expanded: [...ui.expanded, projectKey] })
            select({ projectKey, id })
          }}
          onChanged={() => void refresh()}
          onClose={() => setMemoryProject(null)}
        />
      )}
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  )
}
