import { useT } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { FindResult } from '../../../shared/types'
import { ArrowDown, ArrowUp, Close } from './Icons'

/** Ctrl+F search inside the open session, backed by Chromium's findInPage. */
export default function FindBar({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [text, setText] = useState('')
  const [result, setResult] = useState<FindResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const off = window.api.onFindResult(setResult)
    return () => {
      off()
      window.api.stopFind()
    }
  }, [])

  const run = (forward: boolean, findNext: boolean) => {
    if (text) window.api.find(text, forward, findNext)
  }

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        value={text}
        placeholder={t.find}
        onChange={(e) => {
          const v = e.target.value
          setText(v)
          if (v) window.api.find(v, true, false)
          else {
            window.api.stopFind()
            setResult(null)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            run(!e.shiftKey, true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="find-count">{text && result ? `${result.active}/${result.total}` : ''}</span>
      <button className="icon-btn" title={t.previousMatch} onClick={() => run(false, true)}>
        <ArrowUp width={14} height={14} />
      </button>
      <button className="icon-btn" title={t.nextMatch} onClick={() => run(true, true)}>
        <ArrowDown width={14} height={14} />
      </button>
      <button className="icon-btn" title={t.closeEsc} onClick={onClose}>
        <Close width={14} height={14} />
      </button>
    </div>
  )
}
