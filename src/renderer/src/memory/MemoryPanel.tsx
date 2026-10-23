import { useT, useLanguage } from '../i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MemoryFile, ProjectMemory, ProjectSummary } from '../../../shared/types'
import { ChevronRight, Close, FileText, Search } from '../components/Icons'
import ContextMenu, { type MenuState } from '../components/ContextMenu'
import Markdown, { CopyButton } from '../components/Markdown'
import MemoryBackups from './MemoryBackups'
import MemoryDeleteDialog from '../dialogs/MemoryDeleteDialog'
import { dateTime } from '../lib/time'

const TYPE_ORDER = ['user', 'feedback', 'project', 'reference']

const INDEX_KEY = '__index__'

const labelOf = (f: MemoryFile) => f.title || f.name

interface Props {
  project: ProjectSummary
  /** Finds the conversation a memory came from; null when it is not in the list */
  findSession: (sessionId: string) => { projectKey: string; id: string } | null
  onOpenSession: (projectKey: string, id: string) => void
  /** A memory was deleted or restored; the project list's memory counts are stale */
  onChanged: () => void
  onClose: () => void
}

/** Read-only browser for a project's memory folder: index plus memories grouped by type. */
export default function MemoryPanel({ project, findSession, onOpenSession, onChanged, onClose }: Props) {
  const { language } = useLanguage()
  const t = useT()
  const TYPE_LABEL: Record<string, string> = {
    user: t.typeUser,
    feedback: t.typeFeedback,
    project: t.typeProject,
    reference: t.typeReference,
    '': t.typeOther,
  }
  const [memory, setMemory] = useState<ProjectMemory | null>(null)
  const [selected, setSelected] = useState<string>(INDEX_KEY)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** File of the memory whose deletion is being confirmed */
  const [deleting, setDeleting] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [showBackups, setShowBackups] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    void window.api.getProjectMemory(project.key).then((m) => {
      setMemory(m)
      setSelected((cur) => (cur === INDEX_KEY || m.files.some((f) => f.file === cur) ? cur : INDEX_KEY))
    })
  }, [project.key])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (deleting || showBackups) return // the dialog on top handles Escape while it is open
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, deleting, showBackups])

  // Braces matter: scrollTo() returns a Promise in this Chromium, and an effect must not return it
  // (React would later call it as the cleanup function and crash).
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [selected])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (f: MemoryFile) =>
      !q || [f.name, f.title ?? '', f.description].some((s) => s.toLowerCase().includes(q))
    const byType = new Map<string, MemoryFile[]>()
    for (const f of memory?.files ?? []) {
      if (!match(f)) continue
      const t = TYPE_ORDER.includes(f.type) ? f.type : ''
      byType.set(t, [...(byType.get(t) ?? []), f])
    }
    return [...TYPE_ORDER, '']
      .filter((t) => byType.has(t))
      .map((t) => ({ type: t, files: byType.get(t)!.sort((a, b) => labelOf(a).localeCompare(labelOf(b), language)) }))
  }, [memory, query, language])

  const current = memory?.files.find((f) => f.file === selected)

  // Links between memory files (as in MEMORY.md) open inside the panel instead of leaving the app.
  const onBodyClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href')
    if (!href || /^[a-z]+:/i.test(href)) return
    e.preventDefault()
    e.stopPropagation()
    const file = decodeURIComponent(href.split(/[\\/]/).pop() ?? '').toLowerCase()
    const target = memory?.files.find((f) => f.file.toLowerCase() === file)
    if (target) setSelected(target.file)
  }

  const toggleGroup = (t: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })

  const origin = current?.originSessionId ? findSession(current.originSessionId) : null
  const empty = memory && !memory.index && memory.files.length === 0

  return (
    <>
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`memory-panel${empty ? ' compact' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="memory-head">
          <div className="memory-title">
            <span>{t.memory}</span>
            <span className="memory-project">{project.name}</span>
          </div>
          {memory?.dir ? (
            <button className="memory-dir" title={t.openExplorer} onClick={() => void window.api.openPath(memory.dir!)}>
              {memory.dir}
            </button>
          ) : (
            <span className="memory-dir" />
          )}
          <button
            className="icon-btn memory-head-btn"
            title={t.backupsHint}
            onClick={() => setShowBackups(true)}
          >
            {t.backups}
          </button>
          <button className="icon-btn" title={t.closeEsc} onClick={onClose}>
            <Close width={16} height={16} />
          </button>
        </header>

        {!memory && <div className="memory-empty">{t.loading}</div>}
        {empty && <div className="memory-empty">{t.noMemory}</div>}

        {memory && !empty && (
          <div className="memory-main">
            <nav className="memory-tree">
              <div className="search memory-search">
                <Search className="search-icon" />
                <input value={query} placeholder={t.filterMemory} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="memory-list">
                {memory.index !== null && (
                  <button
                    className={`memory-item index${selected === INDEX_KEY ? ' active' : ''}`}
                    onClick={() => setSelected(INDEX_KEY)}
                  >
                    <FileText width={14} height={14} />
                    <span className="memory-item-label">{t.memoryIndex}</span>
                  </button>
                )}
                {groups.map(({ type, files }) => (
                  <div key={type} className="memory-group">
                    <button className="memory-group-head" onClick={() => toggleGroup(type)}>
                      <ChevronRight
                        width={12}
                        height={12}
                        className={`chevron${collapsed.has(type) ? '' : ' open'}`}
                      />
                      {TYPE_LABEL[type]}
                      <span className="count">{files.length}</span>
                    </button>
                    {!collapsed.has(type) &&
                      files.map((f) => (
                        <button
                          key={f.file}
                          className={`memory-item${selected === f.file ? ' active' : ''}`}
                          title={f.description || f.name}
                          onClick={() => setSelected(f.file)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setMenu({
                              x: e.clientX,
                              y: e.clientY,
                              items: [
                                { label: t.copyPath, onSelect: () => void navigator.clipboard.writeText(f.path) },
                                { label: t.showInFolder, onSelect: () => void window.api.showInFolder(f.path) },
                                { label: t.delete, danger: true, onSelect: () => setDeleting(f.file) },
                              ],
                            })
                          }}
                        >
                          <span className="memory-item-label">{labelOf(f)}</span>
                          {!f.indexed && memory.index !== null && <span className="memory-badge">{t.unindexed}</span>}
                        </button>
                      ))}
                  </div>
                ))}
                {query && groups.length === 0 && <div className="sidebar-empty">{t.noMatchMemory}</div>}
              </div>
            </nav>

            <div className="memory-body" ref={bodyRef} onClickCapture={onBodyClick}>
              {selected === INDEX_KEY || !current ? (
                <>
                  <div className="memory-meta">
                    <h2>MEMORY.md</h2>
                    <span className="memory-sub">{t.memoryCount(memory.files.length)}</span>
                  </div>
                  {memory.missing.length > 0 && (
                    <div className="memory-warn">
                      {t.missingLinks(memory.missing.length, memory.missing.join(t.listSeparator))}
                    </div>
                  )}
                  {memory.index !== null ? (
                    <Markdown text={memory.index} />
                  ) : (
                    <div className="memory-sub">{t.noMemoryIndex}</div>
                  )}
                </>
              ) : (
                <>
                  <div className="memory-meta">
                    <h2>{labelOf(current)}</h2>
                    <div className="memory-chips">
                      {current.type && <span className="memory-chip">{TYPE_LABEL[current.type] ?? current.type}</span>}
                      {!current.indexed && memory.index !== null && <span className="memory-chip warn">{t.unindexed}</span>}
                      {current.modified && <span className="memory-sub">{t.updated(dateTime(Date.parse(current.modified), language))}</span>}
                    </div>
                    {current.description && <p className="memory-desc">{current.description}</p>}
                    <div className="memory-actions">
                      <CopyButton getText={() => current.path} label={t.copyPath} />
                      <button className="icon-btn memory-reveal" onClick={() => void window.api.showInFolder(current.path)}>
                        {t.showInFolder}
                      </button>
                      {origin && (
                        <button
                          className="icon-btn memory-origin"
                          onClick={() => {
                            onOpenSession(origin.projectKey, origin.id)
                            onClose()
                          }}
                        >
                          {t.openOrigin}
                        </button>
                      )}
                      <button className="icon-btn memory-delete" onClick={() => setDeleting(current.file)}>
                        {t.delete}
                      </button>
                    </div>
                  </div>
                  <Markdown text={current.body} />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    {showBackups && (
      <MemoryBackups projectKey={project.key} onClose={() => setShowBackups(false)} onRestored={() => {
          load()
          onChanged()
        }}
      />
    )}
    {deleting && (
      <MemoryDeleteDialog
        projectKey={project.key}
        file={deleting}
        onCancel={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null)
          setSelected(INDEX_KEY)
          load()
          onChanged()
        }}
      />
    )}
    </>
  )
}
