import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ActionError, Language } from '../../../shared/types'
import en from './en'
import zh, { type Dictionary } from './zh'
export { LANGUAGE_LABELS } from './zh'

export const dictionaries: Record<Language, Dictionary> = { zh, en }

interface LanguageContext {
  language: Language
  setLanguage: (language: Language) => void
  t: Dictionary
}

const Context = createContext<LanguageContext>({ language: 'en', setLanguage: () => {}, t: en })

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setCurrent] = useState<Language>('en')
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    void window.api.getUiState().then((ui) => {
      if (!active) return
      setCurrent(ui.language ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'))
      setReady(true)
    })
    return () => { active = false }
  }, [])
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }, [language])
  const value = useMemo<LanguageContext>(() => ({
    language,
    t: dictionaries[language],
    setLanguage: (next) => {
      setCurrent(next)
      void window.api.setUiState({ language: next })
    },
  }), [language])
  return createElement(Context.Provider, { value }, ready ? children : null)
}

export const useT = (): Dictionary => useContext(Context).t
export const useLanguage = (): LanguageContext => useContext(Context)

export function translateError(t: Dictionary, error: ActionError | undefined, fallback = t.requestFailed): string {
  if (!error) return fallback
  switch (error.code) {
    case 'session-open': return t.errorSessionOpen
    case 'session-missing': return t.errorSessionMissing
    case 'project-missing': return t.errorProjectMissing
    case 'name-empty': return t.errorNameEmpty
    case 'memory-missing': return t.memoryMissing
    case 'backup-missing': return t.errorBackupMissing
    case 'trash-failed': return t.errorTrash(error.files.join('\n'))
    case 'directory-missing': return t.errorDirectory(error.path)
    case 'terminal-failed': return t.errorTerminal(error.detail)
    case 'rename-failed': return t.errorRename(error.detail)
    case 'backup-failed': return t.errorBackup(error.detail)
    case 'memory-update-failed': return t.errorMemoryUpdate(error.files.join(t.listSeparator))
    case 'backup-changed': return t.errorBackupChanged(error.files.join(t.listSeparator))
    case 'restore-failed': return t.errorRestore(error.detail, error.path)
    case 'export-failed': return t.exportFailed
    case 'grok-session-open': return t.errorGrokOpen
    case 'grok-mcp-missing': return t.errorGrokMcpMissing
    case 'grok-failed': return t.errorGrok(error.detail)
    case 'codex-running': return t.errorCodexRunning
    case 'codex-failed': return t.errorCodex(error.detail)
  }
}
