import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { searchTerms } from '../shared/search'
import type { ProjectSummary, SearchHit, SearchResponse, SearchResult, SessionSource, SessionVersion } from '../shared/types'
import { codexHistoryMarks, codexSearchText } from './codex'
import { grokSearchText, grokUpdatesFile } from './grok'
import {
  B_ASSISTANT,
  B_SIDECHAIN,
  B_TEXT_BLOCK,
  B_TOOL_RESULT,
  B_USER,
  blocks,
  classifyUser,
  PROJECTS_DIR,
  readLines,
  type RawRecord,
} from './sessions'

/** A typed prompt or one block of Claude's answer text: what the viewer shows, minus commands. */
interface Entry {
  text: string
  lower: string
}

interface FileText {
  size: number
  mtimeMs: number
  /** Byte offset just past the last complete line read */
  offset: number
  entries: Entry[]
}

const MAX_RESULTS = 100

async function readFileText(file: string, prev: FileText | undefined, size: number, mtimeMs: number): Promise<FileText> {
  // A shrunk file was rewritten, so the old offset is meaningless.
  const ft: FileText =
    prev && size >= prev.offset
      ? { ...prev, entries: [...prev.entries] }
      : { size: 0, mtimeMs: 0, offset: 0, entries: [] }
  const push = (text: string): void => {
    ft.entries.push({ text, lower: text.toLowerCase() })
  }
  // Same record filters as loadSession, so every hit is something the opened conversation shows.
  ft.offset = await readLines(file, ft.offset, (line) => {
    if (line.includes(B_SIDECHAIN)) return
    if (line.includes(B_USER)) {
      if (line.includes(B_TOOL_RESULT)) return
    } else if (!line.includes(B_ASSISTANT) || !line.includes(B_TEXT_BLOCK)) {
      return
    }
    let r: RawRecord
    try {
      r = JSON.parse(line.toString('utf8'))
    } catch {
      return
    }
    if (r.type === 'user') {
      const u = classifyUser(r)
      if (u?.kind === 'prompt' && u.text) push(u.text)
      return
    }
    if (r.type !== 'assistant') return
    for (const b of blocks(r.message?.content)) {
      const text = b.type === 'text' ? b.text?.trim() : ''
      if (text) push(text)
    }
  })
  ft.size = size
  ft.mtimeMs = mtimeMs
  return ft
}

/** Grok logs arrive in chunks that only make sense once assembled, so a changed file is read again in full. */
async function readGrokText(file: string, size: number, mtimeMs: number): Promise<FileText> {
  return textOf(await grokSearchText(file), size, mtimeMs)
}

function textOf(texts: string[], size: number, mtimeMs: number): FileText {
  return { size, mtimeMs, offset: size, entries: texts.map((text) => ({ text, lower: text.toLowerCase() })) }
}

function toHit(e: Entry, fileId: string, terms: string[]): SearchHit {
  let at = -1
  let len = 0
  for (const t of terms) {
    const i = e.lower.indexOf(t)
    if (i !== -1 && (at === -1 || i < at)) {
      at = i
      len = t.length
    }
  }
  const start = Math.max(0, at - 30)
  const end = Math.min(e.text.length, at + len + 90)
  const snippet =
    (start > 0 ? '…' : '') + e.text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < e.text.length ? '…' : '')
  const needle = e.text.slice(Math.max(0, at - 15), at + len + 15).trim()
  return { fileId, snippet, needle }
}

/**
 * Text of every conversation, held in memory for content search. Only prompts and answer text are kept, a small
 * fraction of the session files. Built on the first search; later searches read only bytes appended since.
 * Not persisted: the index cache is rewritten on every change and must stay small.
 */
export class SearchIndex {
  private files = new Map<string, FileText>()
  private updating: Promise<void> | null = null
  private latest: ProjectSummary[] = []
  private rerun = false

  private fileOf(source: SessionSource, v: SessionVersion): string {
    if (source === 'codex') return 'codex:' + v.id
    return source === 'grok' ? grokUpdatesFile(v) : join(PROJECTS_DIR, v.dir, v.id + '.jsonl')
  }

  /**
   * Brings the text up to date; called after every project scan so the first search does not wait for it.
   * A call during a refresh triggers one follow-up with the newest project list (same as SessionIndex.scan).
   */
  update(projects: ProjectSummary[]): Promise<void> {
    this.latest = projects
    if (this.updating) {
      this.rerun = true
      return this.updating
    }
    this.updating = (async () => {
      do {
        this.rerun = false
        await this.refresh(this.latest)
      } while (this.rerun)
    })().finally(() => {
      this.updating = null
    })
    return this.updating
  }

  private async refresh(projects: ProjectSummary[]): Promise<void> {
    const wanted = new Set<string>()
    const codexMarks = projects.some((p) => p.source === 'codex') ? codexHistoryMarks() : new Map<string, number>()
    for (const p of projects) {
      for (const s of p.sessions) {
        for (const v of s.versions) {
          const file = this.fileOf(p.source, v)
          wanted.add(file)
          if (p.source === 'codex') {
            // Keyed on the thread's newest history row; `size` holds that mark.
            const mark = codexMarks.get(v.id) ?? 0
            if (this.files.get(file)?.size !== mark) this.files.set(file, textOf(codexSearchText(v.id), mark, 0))
            continue
          }
          try {
            const st = await fs.stat(file)
            const prev = this.files.get(file)
            if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue
            this.files.set(
              file,
              p.source === 'grok' ? await readGrokText(file, st.size, st.mtimeMs) : await readFileText(file, prev, st.size, st.mtimeMs),
            )
          } catch {
            this.files.delete(file)
          }
        }
      }
    }
    for (const file of this.files.keys()) if (!wanted.has(file)) this.files.delete(file)
  }

  /**
   * A conversation matches when every term is in one of its version titles or in one message. Title matches come
   * first. `temp` picks the same side as the sidebar: temp-folder and scripted conversations, or the rest.
   */
  async search(projects: ProjectSummary[], query: string, temp: boolean, source: SessionSource): Promise<SearchResponse> {
    const terms = searchTerms(query)
    if (!terms.length) return { results: [], truncated: false }
    await this.update(projects)

    const has = (lower: string) => terms.every((t) => lower.includes(t))
    const found: { result: SearchResult; activity: number }[] = []
    for (const p of projects) {
      if (p.source !== source) continue
      for (const s of p.sessions) {
        if ((p.isTemp || s.headless) !== temp) continue
        // Primary file first: other versions mostly repeat its history, so they only matter when it has no match.
        const versions = [...s.versions].sort((a, b) => Number(b.id === s.id) - Number(a.id === s.id))
        let hit: SearchHit | undefined
        for (const v of versions) {
          const e = this.files.get(this.fileOf(p.source, v))?.entries.find((x) => has(x.lower))
          if (e) {
            hit = toHit(e, v.id, terms)
            break
          }
        }
        const titleMatch = s.versions.some((v) => has(v.title.toLowerCase()))
        if (hit || titleMatch) {
          found.push({ result: { projectKey: p.key, id: s.id, titleMatch, hit }, activity: s.familyActivity })
        }
      }
    }
    found.sort((a, b) => Number(b.result.titleMatch) - Number(a.result.titleMatch) || b.activity - a.activity)
    return { results: found.slice(0, MAX_RESULTS).map((f) => f.result), truncated: found.length > MAX_RESULTS }
  }
}
