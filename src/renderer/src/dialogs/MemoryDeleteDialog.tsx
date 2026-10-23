import { useT, translateError } from '../i18n'
import { useEffect, useState, type ReactNode } from 'react'
import { DELETED_NOTES } from '../../../shared/types'
import type { MemoryDeletePlan, MemoryLineChange } from '../../../shared/types'
import GraphCanvas from './GraphCanvas'
import { FileText } from '../components/Icons'

const NOTE_RE = Object.values(DELETED_NOTES)
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')
const MARK = new RegExp(`~~([\\s\\S]+?)~~(${NOTE_RE})`, 'g')
/** Characters of context kept on each side of a change in long lines */
const CONTEXT = 36

function clip(text: string, from: number, to: number): string {
  const start = Math.max(0, from - CONTEXT)
  const end = Math.min(text.length, to + CONTEXT)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/** A struck-through line, trimmed to the area around the change, with the change highlighted. */
function StruckLine({ after }: { after: string }) {
  const first = after.indexOf('~~')
  const marks = [...after.matchAll(MARK)]
  const lastMark = marks[marks.length - 1]
  const text = clip(after, first, lastMark ? lastMark.index! + lastMark[0].length : after.length)
  const parts: ReactNode[] = []
  let pos = 0
  for (const m of text.matchAll(MARK)) {
    parts.push(text.slice(pos, m.index))
    parts.push(
      <mark key={m.index} className="mem-mark">
        <del>{m[1]}</del>
        {m[2]}
      </mark>,
    )
    pos = m.index! + m[0].length
  }
  parts.push(text.slice(pos))
  return <div className="mem-line">{parts}</div>
}

function LineView({ line }: { line: MemoryLineChange }) {
  if (line.after === null) return <div className="mem-line removed">{line.before}</div>
  return <StruckLine after={line.after} />
}

interface Props {
  projectKey: string
  file: string
  onCancel: () => void
  onDeleted: () => void
}

/** Shows what deleting a memory changes: the memory itself, linked to every file whose links get rewritten. */
export default function MemoryDeleteDialog({ projectKey, file, onCancel, onDeleted }: Props) {
  const t = useT()
  const [plan, setPlan] = useState<MemoryDeletePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.planMemoryDelete(projectKey, file)
      .then((p) => {
        setPlan(p)
        if (!p) setError(t.memoryMissing)
      })
      .catch((e: Error) => setError(e.message))
  }, [projectKey, file])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation()
        onCancel()
      }
    }
    // Capture phase, so Escape closes this dialog before the memory panel underneath sees it.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onCancel])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.runMemoryDelete(projectKey, file)
      if (r.ok) onDeleted()
      else {
        setBusy(false)
        setError(translateError(t, r.error, t.deleteFailed))
      }
    } catch (e) {
      setBusy(false)
      setError((e as Error).message)
    }
  }

  return (
    <div className="modal-backdrop mem-del-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div className="mem-del" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t.deleteMemory}</h2>
        {!plan && !error && <p className="modal-hint">{t.analyzing}</p>}
        {plan && (
          <>
            <GraphCanvas
              target={
                <>
                  <div className="mem-target-label">
                    <FileText width={15} height={15} />
                    {plan.target.label}
                  </div>
                  {plan.target.description && <p>{plan.target.description}</p>}
                </>
              }
            >
              {plan.changes.length === 0 && <div className="mem-none">{t.noReferences}</div>}
              {plan.changes.map((c) => (
                <div key={c.file} className="mem-card" data-card>
                  <div className="mem-card-head">
                    <FileText width={13} height={13} />
                    <span>{c.label}</span>
                  </div>
                  {c.lines.map((l, i) => (
                    <LineView key={i} line={l} />
                  ))}
                </div>
              ))}
            </GraphCanvas>
            <p className="mem-del-note">
              {t.memoryBackupNote}
              {plan.changes.length > 0 && t.memoryBackupChanges(plan.changes.length)}
              {t.memoryBackupRestore}
              {plan.projectLive && <span className="mem-del-live">{t.memoryLiveWarning}</span>}
            </p>
          </>
        )}
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            {t.cancel}
          </button>
          <button className="btn danger" onClick={() => void confirm()} disabled={!plan || busy}>
            {busy ? t.deleting : t.delete}
          </button>
        </div>
      </div>
    </div>
  )
}
