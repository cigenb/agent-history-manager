import { useT } from '../i18n'
import { memo, useMemo, useState } from 'react'
import type { DocEdit } from '../../../shared/types'
import { lineDiff, type DiffLine } from '../lib/diff'
import { ChevronRight, FileText } from './Icons'

/** Opens the file's current content in the right panel, with these replacements highlighted. */
export type PreviewDoc = (path: string, hunks: DocEdit['hunks']) => void

/** All edits a turn made to one file, shown as one card. */
interface FileChanges {
  path: string
  /** Set when every change to the file in this turn was a full Write */
  written: boolean
  hunks: DiffLine[][]
  replacements: DocEdit['hunks']
}

function groupByFile(edits: DocEdit[]): FileChanges[] {
  const byPath = new Map<string, FileChanges>()
  for (const e of edits) {
    const key = e.path.toLowerCase()
    let f = byPath.get(key)
    if (!f) byPath.set(key, (f = { path: e.path, written: true, hunks: [], replacements: [] }))
    if (e.kind !== 'write') f.written = false
    for (const h of e.hunks) f.hunks.push(lineDiff(h.old, h.new))
    f.replacements.push(...e.hunks)
  }
  return [...byPath.values()]
}

export function displayPath(path: string, base: string): { name: string; dir: string } {
  const norm = path.replace(/\//g, '\\')
  const rel =
    base && norm.toLowerCase().startsWith(base.toLowerCase().replace(/\\?$/, '\\'))
      ? norm.slice(base.replace(/\\?$/, '\\').length)
      : norm
  const cut = rel.lastIndexOf('\\')
  return cut < 0 ? { name: rel, dir: '' } : { name: rel.slice(cut + 1), dir: rel.slice(0, cut + 1) }
}

function FileCard({ change, base, onPreview }: { change: FileChanges; base: string; onPreview: PreviewDoc }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const { name, dir } = displayPath(change.path, base)
  const added = change.hunks.reduce((n, h) => n + h.filter((l) => l.type === '+').length, 0)
  const removed = change.hunks.reduce((n, h) => n + h.filter((l) => l.type === '-').length, 0)

  return (
    <div className={`doc-edit${open ? ' open' : ''}`}>
      {/* A div, not a button: it holds the preview button, and buttons cannot nest. */}
      <div
        className="doc-edit-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={change.path}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
          e.preventDefault()
          setOpen((v) => !v)
        }}
      >
        <FileText width={15} height={15} className="doc-edit-icon" />
        <span className="doc-edit-name">{name}</span>
        {dir && <span className="doc-edit-dir">{dir}</span>}
        {change.written && <span className="doc-edit-tag">{t.written}</span>}
        <button
          className="doc-edit-tag doc-preview-tag"
          title={t.previewDocHint}
          onClick={(e) => {
            e.stopPropagation()
            onPreview(change.path, change.replacements)
          }}
        >
          {t.previewDoc}
        </button>
        <span className="doc-edit-stat">
          {added > 0 && <span className="add">+{added}</span>}
          {removed > 0 && <span className="del">−{removed}</span>}
        </span>
        <ChevronRight width={13} height={13} className="doc-edit-chevron" />
      </div>
      {open && (
        <div className="doc-edit-body">
          {change.hunks.map((hunk, i) => (
            <div key={i} className="diff-hunk">
              {hunk.map((l, j) => (
                <div key={j} className={`diff-line${l.type === '+' ? ' add' : l.type === '-' ? ' del' : ''}`}>
                  <span className="diff-mark">{l.type === ' ' ? '' : l.type === '+' ? '+' : '−'}</span>
                  <span className="diff-text">{l.text || ' '}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Markdown files changed in one assistant turn; collapsed by default. */
export default memo(function DocEdits({ edits, base, onPreview }: { edits: DocEdit[]; base: string; onPreview: PreviewDoc }) {
  const files = useMemo(() => groupByFile(edits), [edits])
  if (files.length === 0) return null
  return (
    <div className="doc-edits">
      {files.map((f) => (
        <FileCard key={f.path} change={f} base={base} onPreview={onPreview} />
      ))}
    </div>
  )
})
