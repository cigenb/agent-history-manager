import { useT } from '../i18n'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { searchTerms } from '../../../shared/search'
import type { ProjectSummary, SearchHit, SearchResponse, SessionSource } from '../../../shared/types'

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  const parts = text.split(new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi'))
  // split() with one capture group puts the matches at the odd indexes.
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>
}

interface Props {
  query: string
  temp: boolean
  source: SessionSource
  projects: ProjectSummary[]
  selectedId: string | null
  onOpen: (projectKey: string, id: string, hit: SearchHit | undefined, terms: string[]) => void
}

/** Search results, shown in the sidebar in place of the project list while the search box has text. */
export default function SearchResults({ query, temp, source, projects, selectedId, onOpen }: Props) {
  const t = useT()
  const q = query.trim()
  const [state, setState] = useState<{
    query: string
    temp: boolean
    source: SessionSource
    response: SearchResponse | null
    failed: boolean
  } | null>(null)

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      window.api.searchSessions(q, temp, source).then(
        (response) => { if (active) setState({ query: q, temp, source, response, failed: false }) },
        () => { if (active) setState({ query: q, temp, source, response: null, failed: true }) },
      )
    }, 150)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [q, temp, source, projects]) // projects: a rescan can bring new matches or move a conversation to a new primary id

  const sessions = useMemo(() => {
    const out = new Map<string, { project: ProjectSummary; title: string }>()
    for (const p of projects) for (const s of p.sessions) out.set(`${p.key}\u0000${s.id}`, { project: p, title: s.title })
    return out
  }, [projects])

  const terms = useMemo(() => searchTerms(state?.query ?? ''), [state?.query])
  const pending = state?.query !== q || state.temp !== temp || state.source !== source

  if (!state?.response) {
    return <div className="sidebar-empty">{state?.failed && !pending ? t.searchFailed : t.searching}</div>
  }
  const results = state.response.results.filter((r) => sessions.has(`${r.projectKey}\u0000${r.id}`))
  if (!results.length) return <div className="sidebar-empty">{pending ? t.searching : t.noSearchResults}</div>

  return (
    <div className={`search-results${pending ? ' pending' : ''}`}>
      {results.map((r) => {
        const s = sessions.get(`${r.projectKey}\u0000${r.id}`)!
        return (
          <button
            key={`${r.projectKey}\u0000${r.id}`}
            className={`search-result${r.id === selectedId ? ' active' : ''}`}
            title={s.project.path}
            onClick={() => onOpen(r.projectKey, r.id, r.hit, terms)}
          >
            <span className="search-result-head">
              <span className="search-result-title">
                <Highlighted text={s.title || t.untitled} terms={terms} />
              </span>
              <span className="search-result-project">{s.project.projectless ? t.noProject : s.project.name}</span>
            </span>
            {r.hit && (
              <span className="search-result-snippet">
                <Highlighted text={r.hit.snippet} terms={terms} />
              </span>
            )}
          </button>
        )
      })}
      {state.response.truncated && <div className="sidebar-empty">{t.searchTruncated(state.response.results.length)}</div>}
    </div>
  )
}
