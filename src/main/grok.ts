import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  AgentDetail,
  AgentRun,
  ImageData,
  ProjectSummary,
  SessionDetail,
  SessionSummary,
  SessionVersion,
  Turn,
} from '../shared/types'
import { projectKeyOf, readLines, SAFE_SEGMENT, TEMP_PATTERNS } from './sessions'

type AssistantTurn = Extract<Turn, { kind: 'assistant' }>
type UserTurn = Extract<Turn, { kind: 'user' }>

export const GROK_HOME = process.env.GROK_HOME || join(homedir(), '.grok')
export const GROK_SESSIONS_DIR = join(GROK_HOME, 'sessions')

const KEY_PREFIX = 'grok:'
export const isGrokKey = (key: string): boolean => key.startsWith(KEY_PREFIX)

export const grokSessionDir = (v: SessionVersion): string => join(GROK_SESSIONS_DIR, v.dir, v.id)
export const grokUpdatesFile = (v: SessionVersion): string => join(grokSessionDir(v), 'updates.jsonl')

export function grokExecutable(): string {
  const bundled = join(GROK_HOME, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')
  return existsSync(bundled) ? bundled : 'grok'
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const cleanPrompt = (text: string): string => text.replace(SYSTEM_REMINDER, '').trim()

// ---- records ---------------------------------------------------------------

interface Update {
  sessionUpdate?: string
  content?: { type?: string; text?: string; data?: string; mimeType?: string }
  _meta?: { promptIndex?: number }
  child_session_id?: string
  description?: string
  subagent_type?: string
  model?: string
}

interface UpdateRecord {
  /** Seconds */
  timestamp?: number
  params?: { _meta?: { agentTimestampMs?: number }; update?: Update }
}

/** Byte keys of the records the viewer uses; JSON string values escape quotes, so these only match structure. */
const B_USER_CHUNK = Buffer.from('"sessionUpdate":"user_message_chunk"')
const B_RECORDS = [
  B_USER_CHUNK,
  ...['agent_message_chunk', 'tool_call', 'turn_completed', 'subagent_spawned'].map((k) => Buffer.from(`"sessionUpdate":"${k}"`)),
]

function parseRecord(line: Buffer): UpdateRecord | null {
  if (!B_RECORDS.some((b) => line.includes(b))) return null
  try {
    return JSON.parse(line.toString('utf8')) as UpdateRecord
  } catch {
    return null
  }
}

const recordTime = (r: UpdateRecord): number => r.params?._meta?.agentTimestampMs ?? (r.timestamp ? r.timestamp * 1000 : 0)

function parseTs(s: string | undefined): number {
  const t = s ? Date.parse(s) : NaN
  return Number.isNaN(t) ? 0 : t
}

// ---- index scan ------------------------------------------------------------

const CACHE_VERSION = 1

/** Per updates.jsonl scan state; later scans read only bytes appended since `offset`. */
interface FileIndex {
  size: number
  mtimeMs: number
  offset: number
  promptCount: number
  firstPrompt?: string
  /** promptIndex of the last user chunk; chunks of one prompt share it */
  lastPromptIndex?: number
}

interface GrokSummaryFile {
  info?: { id?: string; cwd?: string }
  session_kind?: string | null
  title?: string
  generated_title?: string
  session_summary?: string
  updated_at?: string
  last_active_at?: string
}

async function indexFile(file: string, prev: FileIndex | undefined, size: number, mtimeMs: number): Promise<FileIndex> {
  const idx: FileIndex = prev && size >= prev.offset ? { ...prev } : { size: 0, mtimeMs: 0, offset: 0, promptCount: 0 }
  idx.offset = await readLines(file, idx.offset, (line) => {
    if (!line.includes(B_USER_CHUNK)) return
    const u = parseRecord(line)?.params?.update
    const pi = u?._meta?.promptIndex
    if (pi === undefined || pi !== idx.lastPromptIndex) idx.promptCount++
    idx.lastPromptIndex = pi
    if (!idx.firstPrompt && u?.content?.type === 'text' && u.content.text) idx.firstPrompt = cleanPrompt(u.content.text).slice(0, 200)
  })
  idx.size = size
  idx.mtimeMs = mtimeMs
  return idx
}

/** Hidden child sessions of Grok's own subagents; they are shown under their parent. */
const CHILD_KINDS = new Set(['subagent', 'subagent_fork'])

function decodeFolder(dir: string): string {
  try {
    return decodeURIComponent(dir)
  } catch {
    return dir
  }
}

export class GrokIndex {
  private cache: { version: number; files: Record<string, FileIndex> } = { version: CACHE_VERSION, files: {} }
  private loaded = false
  private running: Promise<ProjectSummary[]> | null = null
  private rerun = false
  private cachePath: string

  constructor(cachePath: string) {
    this.cachePath = cachePath
  }

  /** Coalesces concurrent calls like SessionIndex.scan. */
  scan(): Promise<ProjectSummary[]> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = (async () => {
      let result: ProjectSummary[]
      do {
        this.rerun = false
        result = await this.scanOnce()
      } while (this.rerun)
      return result
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async scanOnce(): Promise<ProjectSummary[]> {
    if (!this.loaded) {
      this.loaded = true
      try {
        const c = JSON.parse(await fs.readFile(this.cachePath, 'utf8'))
        if (c.version === CACHE_VERSION) this.cache = c
      } catch {
        /* first run */
      }
    }
    const nextFiles: Record<string, FileIndex> = {}
    let changed = false
    const groups = new Map<string, { path: string; sessions: SessionSummary[] }>()
    let dirs: string[] = []
    try {
      dirs = (await fs.readdir(GROK_SESSIONS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return []
    }
    for (const dir of dirs) {
      let ids: string[]
      try {
        ids = (await fs.readdir(join(GROK_SESSIONS_DIR, dir), { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      } catch {
        continue
      }
      for (const id of ids) {
        const folder = join(GROK_SESSIONS_DIR, dir, id)
        let summary: GrokSummaryFile
        try {
          summary = JSON.parse(await fs.readFile(join(folder, 'summary.json'), 'utf8'))
        } catch {
          continue
        }
        if (CHILD_KINDS.has(summary.session_kind ?? '')) continue
        const file = join(folder, 'updates.jsonl')
        let st
        try {
          st = await fs.stat(file)
        } catch {
          continue
        }
        const prev = this.cache.files[file]
        let idx = prev
        if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
          idx = await indexFile(file, prev, st.size, st.mtimeMs)
          changed = true
        }
        nextFiles[file] = idx
        if (idx.promptCount === 0) continue

        const path = summary.info?.cwd || decodeFolder(dir)
        const key = KEY_PREFIX + projectKeyOf(path)
        const lastActivity = parseTs(summary.last_active_at || summary.updated_at) || st.mtimeMs
        const prompt = idx.firstPrompt?.split('\n')[0]
        const title = (summary.title || summary.generated_title || summary.session_summary || prompt || '')
          .trim()
          .slice(0, 120)
        const version: SessionVersion = { id, dir, title, lastActivity, promptCount: idx.promptCount }
        let g = groups.get(key)
        if (!g) groups.set(key, (g = { path, sessions: [] }))
        g.sessions.push({
          ...version,
          projectKey: key,
          familyActivity: lastActivity,
          headless: summary.session_kind === 'headless',
          versions: [version],
        })
      }
    }

    if (changed || Object.keys(nextFiles).length !== Object.keys(this.cache.files).length) {
      this.cache = { version: CACHE_VERSION, files: nextFiles }
      await fs.writeFile(this.cachePath, JSON.stringify(this.cache)).catch(() => undefined)
    }
    const projects: ProjectSummary[] = []
    for (const [key, { path, sessions }] of groups) {
      sessions.sort((a, b) => b.familyActivity - a.familyActivity)
      projects.push({
        source: 'grok',
        key,
        path,
        name: basename(path) || path,
        isTemp: TEMP_PATTERNS.some((p) => p.test(path)),
        lastActivity: sessions[0].familyActivity,
        memoryCount: 0,
        sessions,
      })
    }
    return projects.sort((a, b) => b.lastActivity - a.lastActivity)
  }
}

// ---- full session load -----------------------------------------------------

/** A session folder anywhere under ~/.grok/sessions; a subagent can run in another working directory. */
export async function findGrokSessionDir(id: string): Promise<string | null> {
  if (!SAFE_SEGMENT.test(id)) return null
  let dirs: string[]
  try {
    dirs = await fs.readdir(GROK_SESSIONS_DIR)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const folder = join(GROK_SESSIONS_DIR, dir, id)
    if (existsSync(join(folder, 'updates.jsonl'))) return folder
  }
  return null
}

interface SubagentMeta {
  child_session_id?: string
  subagent_type?: string
  description?: string
  status?: string
  tool_calls?: number
  effective_model_id?: string
}

/** Subagents a session started, from `<session>/subagents/<id>/meta.json`, keyed by child session id. */
export async function readGrokAgents(sessionDir: string): Promise<Map<string, AgentRun>> {
  const out = new Map<string, AgentRun>()
  let names: string[]
  try {
    names = await fs.readdir(join(sessionDir, 'subagents'))
  } catch {
    return out
  }
  for (const name of names) {
    let meta: SubagentMeta
    try {
      meta = JSON.parse(await fs.readFile(join(sessionDir, 'subagents', name, 'meta.json'), 'utf8'))
    } catch {
      continue
    }
    const id = meta.child_session_id || name
    const state: AgentRun['state'] =
      meta.status === 'completed' ? 'done' : !meta.status || meta.status === 'running' || meta.status === 'initializing' ? 'open' : 'stopped'
    out.set(id, {
      id: (await findGrokSessionDir(id)) ? id : null,
      description: meta.description || '',
      type: meta.subagent_type || 'general-purpose',
      model: meta.effective_model_id,
      state,
      toolCalls: meta.tool_calls ?? 0,
    })
  }
  return out
}

/**
 * Visible turns of a Grok session log: prompts, and per answer the text after its last tool call, with the
 * commentary between tool calls as steps. Text arrives in chunks; a turn ends at `turn_completed`, and text
 * after that without a new prompt starts a new turn behind a `resume` marker.
 */
export async function readGrokTurns(
  file: string,
  agents: Map<string, AgentRun>,
): Promise<{ turns: Turn[]; firstTime: number; lastTime: number } | null> {
  const turns: Turn[] = []
  let firstTime = 0
  let lastTime = 0
  let user: UserTurn | null = null
  let userIndex: number | undefined
  let lastWasUser = false
  /** Text of the open answer, one string per stretch between tool calls */
  let segments: string[] | null = null
  let toolSinceText = false
  let ended = false

  const close = (): void => {
    const last = turns[turns.length - 1]
    if (segments && last?.kind === 'assistant') {
      const parts = segments.map((s) => s.trim()).filter(Boolean)
      last.text = parts.pop() ?? ''
      last.steps = parts
    }
    segments = null
    toolSinceText = false
  }

  const open = (ts: number): AssistantTurn => {
    const last = turns[turns.length - 1]
    if (segments && last?.kind === 'assistant') return last
    if (ended) {
      turns.push({ kind: 'resume', source: 'other', time: ts })
      ended = false
    }
    segments = []
    toolSinceText = false
    const turn: AssistantTurn = { kind: 'assistant', text: '', steps: [], edits: [], agents: [], mcp: [], time: ts }
    turns.push(turn)
    return turn
  }

  try {
    await readLines(file, 0, (line) => {
      const r = parseRecord(line)
      const u = r?.params?.update
      if (!r || !u) return
      const ts = recordTime(r)
      const mark = (): void => {
        if (!ts) return
        if (!firstTime || ts < firstTime) firstTime = ts
        if (ts > lastTime) lastTime = ts
      }
      const kind = u.sessionUpdate
      if (kind === 'user_message_chunk') {
        const pi = u._meta?.promptIndex
        const continuing = user !== null && turns[turns.length - 1] === user && (pi !== undefined ? pi === userIndex : lastWasUser)
        if (!continuing) {
          close()
          ended = false
          user = { kind: 'user', text: '', images: [], time: ts }
          turns.push(user)
          userIndex = pi
          mark()
        }
        lastWasUser = true
        const c = u.content
        if (c?.type === 'text' && c.text) user!.text += c.text
        else if (c?.type === 'image' && c.data) user!.images.push({ mediaType: c.mimeType || 'image/png', data: c.data } as ImageData)
        return
      }
      lastWasUser = false
      if (kind === 'agent_message_chunk') {
        const text = u.content?.type === 'text' ? u.content.text : undefined
        if (!text) return
        const turn = open(ts)
        const segs = segments!
        if (toolSinceText || segs.length === 0) segs.push('')
        segs[segs.length - 1] += text
        toolSinceText = false
        turn.time = ts || turn.time
        mark()
      } else if (kind === 'tool_call') {
        if (segments) toolSinceText = true
      } else if (kind === 'subagent_spawned') {
        const turn = open(ts)
        const id = u.child_session_id ?? ''
        turn.agents.push(
          agents.get(id) ?? {
            id: null,
            description: u.description || '',
            type: u.subagent_type || 'general-purpose',
            model: u.model,
            state: 'open',
            toolCalls: 0,
          },
        )
        toolSinceText = true
      } else if (kind === 'turn_completed') {
        close()
        ended = true
      }
    })
    close()
  } catch {
    return null
  }
  for (const t of turns) if (t.kind === 'user') t.text = cleanPrompt(t.text)
  return { turns: turns.filter((t) => t.kind !== 'user' || t.text || t.images.length), firstTime, lastTime }
}

export async function loadGrokSession(
  project: ProjectSummary,
  family: SessionSummary,
  v: SessionVersion,
): Promise<SessionDetail | null> {
  if (!SAFE_SEGMENT.test(v.dir) || !SAFE_SEGMENT.test(v.id)) return null
  const read = await readGrokTurns(grokUpdatesFile(v), await readGrokAgents(grokSessionDir(v)))
  if (!read) return null
  return {
    source: 'grok',
    id: v.id,
    familyId: family.id,
    projectKey: project.key,
    versions: family.versions,
    path: project.path,
    ...read,
  }
}

/** A subagent's own session, started from session `v`. */
export async function loadGrokAgent(v: SessionVersion, agentId: string): Promise<AgentDetail | null> {
  if (!SAFE_SEGMENT.test(v.dir) || !SAFE_SEGMENT.test(v.id)) return null
  const run = (await readGrokAgents(grokSessionDir(v))).get(agentId)
  const dir = run?.id ? await findGrokSessionDir(agentId) : null
  if (!run || !dir) return null
  const read = await readGrokTurns(join(dir, 'updates.jsonl'), await readGrokAgents(dir))
  return read ? { run, turns: read.turns } : null
}

/** Prompts and answer text of a session, the same text the viewer shows, for content search. */
export async function grokSearchText(file: string): Promise<string[]> {
  const read = await readGrokTurns(file, new Map())
  const out: string[] = []
  for (const t of read?.turns ?? []) {
    if (t.kind === 'user' && t.text) out.push(t.text)
    else if (t.kind === 'assistant') out.push(...t.steps, ...(t.text ? [t.text] : []))
  }
  return out
}
