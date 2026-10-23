import { useT, translateError, useLanguage } from '../i18n'
import { useCallback, useEffect, useState } from 'react'
import type { MemoryBackup } from '../../../shared/types'
import { dateTime } from '../lib/time'

/** Memory deletions of one project that can be undone; restoring puts every backed-up file back. */
export default function MemoryBackups({
  projectKey,
  onClose,
  onRestored,
}: {
  projectKey: string
  onClose: () => void
  onRestored: () => void
}) {
  const { language } = useLanguage()
  const t = useT()
  const [backups, setBackups] = useState<MemoryBackup[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.api.listMemoryBackups(projectKey).then(setBackups).catch((e: Error) => setError(e.message))
  }, [projectKey])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return
      e.stopPropagation()
      onClose()
    }
    // Capture phase, so Escape closes this list before the memory panel underneath sees it.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onClose])

  const restore = async (b: MemoryBackup) => {
    setBusy(b.id)
    setError(null)
    try {
      const r = await window.api.restoreMemoryBackup(projectKey, b.id, b.changed)
      if (!r.ok) setError(translateError(t, r.error, t.restoreFailed))
      if (r.ok) onRestored()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      load()
    }
  }

  return (
    <div className="modal-backdrop mem-del-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="backups" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t.memoryBackups}</h2>
        <p className="modal-hint">{t.backupHint}</p>
        {error && <p className="modal-error">{error}</p>}
        <div className="backup-list">
          {backups?.length === 0 && <div className="mem-none">{t.noBackups}</div>}
          {backups?.map((b) => (
            <div key={b.id} className="backup-item">
              <div className="backup-main">
                <div className="backup-title">
                  {t.deletedLabel(b.deletedLabel)}
                  <span className="backup-time">{dateTime(Date.parse(b.time), language)}</span>
                </div>
                <div className="backup-files">{t.restoreFiles(b.files.join(t.listSeparator))}</div>
                {b.changed.length > 0 && (
                  <div className="backup-warn">{t.overwriteWarning(b.changed.join(t.listSeparator))}</div>
                )}
              </div>
              <button className="btn" disabled={!!busy} onClick={() => void restore(b)}>
                {busy === b.id ? t.restoring : b.changed.length ? t.overwriteRestore : t.restore}
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="link-btn backup-folder" onClick={() => void window.api.openMemoryBackups()}>
            {t.openBackupsFolder}
          </button>
          <button className="btn" onClick={onClose} disabled={!!busy}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  )
}
