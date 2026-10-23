import type { Language } from '../../../shared/types'
import { dictionaries } from '../i18n'

const pad = (n: number): string => String(n).padStart(2, '0')

export function dateTime(ms: number, language: Language): string {
  if (!ms) return ''
  const d = new Date(ms)
  if (language === 'en') {
    return new Intl.DateTimeFormat('en', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(d)
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function dayLabel(ms: number, language: Language): string {
  const d = new Date(ms)
  return dictionaries[language].dayLabel(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getDay())
}

export function clock(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
