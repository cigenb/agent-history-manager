import { useT, translateError } from '../i18n'
import { useEffect, useState } from 'react'
import type { DeleteItem, DeleteKind, DeletePlan, DeleteTarget } from '../../../shared/types'
import GraphCanvas from './GraphCanvas'
import { ChevronRight, FileText, Folder } from '../components/Icons'

export interface DeleteRequest {
  target: DeleteTarget
  /** Conversation title or project name */
  name: string
  /** Project path, or how many versions the conversation has */
  detail?: string
  /** Project deletes: titles of the conversations that go with it */
  sessionTitles?: string[]
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

const sum = (xs: DeleteItem[]) => xs.reduce((n, x) => n + x.bytes, 0)


const shortPath = (p: string) => p.replace(/^[a-z]:\\Users\\[^\\]+/i, '~')

/** Files open their containing folder; folders open themselves. */
const folderOf = (p: string) => (/\.[a-z0-9]+$/i.test(p) ? p.replace(/[\\/][^\\/]+$/, '') : p)

export default function DeleteDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: DeleteRequest
  onCancel: () => void
  onConfirm: (target: DeleteTarget, kinds: DeleteKind[]) => Promise<void>
}) {
  const t = useT()
  const KINDS: { kind: DeleteKind; label: string }[] = [
    { kind: 'sessions', label: t.kindSessions },
    { kind: 'artifacts', label: t.kindArtifacts },
    { kind: 'history', label: t.kindHistory },
    { kind: 'temp', label: t.kindTemp },
    { kind: 'memory', label: t.kindMemory },
  ]
  const [plan, setPlan] = useState<DeletePlan | null>(null)
  const [chosen, setChosen] = useState<Set<DeleteKind>>(new Set())
  /** Kind whose exact paths are shown as a third column */
  const [opened, setOpened] = useState<DeleteKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isProject = request.target.kind === 'project'

  useEffect(() => {
    void window.api.planDelete(request.target)
      .then((p) => {
        setPlan(p)
        setChosen(new Set(p.items.map((i) => i.kind))) // everything selected by default
      })
      .catch((e: Error) => setError(e.message))
  }, [request])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const groups = plan
    ? KINDS.map((k) => ({ ...k, items: plan.items.filter((i) => i.kind === k.kind) })).filter((g) => g.items.length)
    : []
  const total = plan ? sum(plan.items.filter((i) => chosen.has(i.kind))) : 0

  const flip = (s: Set<DeleteKind>, kind: DeleteKind) => {
    const next = new Set(s)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    return next
  }
  const toggle = (kind: DeleteKind) => setChosen((s) => flip(s, kind))
  const openedItems = groups.find((g) => g.kind === opened)?.items ?? []

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div className="mem-del" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{isProject ? t.deleteProject : t.deleteSession}</h2>
        {!plan && !error && <p className="modal-hint">{t.countingFiles}</p>}
        {error && <p className="modal-error">{error}</p>}
        {plan && (
          <>
            <GraphCanvas
              target={
                <>
                  <div className="mem-target-label">
                    {isProject ? <Folder width={15} height={15} /> : <FileText width={15} height={15} />}
                    {request.name}
                  </div>
                  {request.detail && <p>{request.detail}</p>}
                </>
              }
              branch={
                opened && openedItems.length
                  ? {
                      from: opened,
                      // Exactly what gets removed: each session's own file or folder, never a parent folder.
                      children: openedItems.map((it) => (
                        <button
                          key={it.path}
                          className="leaf-card"
                          data-leaf
                          title={t.openExplorer}
                          onClick={() => void window.api.openPath(folderOf(it.path))}
                        >
                          <span className="leaf-path">{shortPath(it.path)}</span>
                          <span className="leaf-size">{formatBytes(it.bytes)}</span>
                        </button>
                      )),
                    }
                  : undefined
              }
            >
              {groups.map((g) => {
                const on = chosen.has(g.kind)
                const listed = opened === g.kind
                return (
                  <div
                    key={g.kind}
                    className={`mem-card del-card${on ? '' : ' off'}${listed ? ' expanded' : ''}`}
                    data-card
                    data-card-key={g.kind}
                    data-muted={on ? '0' : '1'}
                    title={listed ? t.collapse : t.expandDeleteItems}
                    // Clicking the card only expands it; selection is the checkbox alone, so the two never mix.
                    onClick={() => setOpened((k) => (k === g.kind ? null : g.kind))}
                  >
                    <div className="mem-card-head">
                      <input
                        type="checkbox"
                        checked={on}
                        title={on ? t.deselectKind : t.selectKind}
                        onChange={() => toggle(g.kind)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="del-card-title">{g.label}</span>
                      <span className="mem-card-size">
                        {t.items(g.items.length)} · {formatBytes(sum(g.items))}
                      </span>
                      <ChevronRight width={13} height={13} className={`chevron${listed ? ' open' : ''}`} />
                    </div>
                    {g.kind === 'sessions' && request.sessionTitles && (
                      <div className="del-titles">
                        {request.sessionTitles.map((t, i) => (
                          <div key={i}>{t}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </GraphCanvas>
            {plan.blocked ? (
              <p className="modal-error">{translateError(t, plan.blocked)}</p>
            ) : (
              <p className="mem-del-note">
                {t.recycleBefore(formatBytes(total))}
                <button className="link-btn" onClick={() => void window.api.openRecycleBin()}>
                  {t.recycleBin}
                </button>
                {t.recycleAfter}
              </p>
            )}
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            {t.cancel}
          </button>
          <button
            className="btn danger"
            disabled={!plan || !!plan.blocked || chosen.size === 0 || busy}
            onClick={async () => {
              setBusy(true)
              await onConfirm(request.target, [...chosen])
            }}
          >
            {busy ? t.deleting : t.moveToRecycleBin}
          </button>
        </div>
      </div>
    </div>
  )
}
