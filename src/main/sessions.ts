import { createReadStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  AgentDetail,
  AgentRun,
  DocEdit,
  ImageData,
  McpUse,
  ProjectSummary,
  SessionDetail,
  SessionSummary,
  SessionVersion,
  Turn,
} from '../shared/types'

type AssistantTurn = Extract<Turn, { kind: 'assistant' }>

export const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** Claude Code's folder name for a working directory: every non-alphanumeric character becomes '-'. */
export function projectFolderName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

export function projectMemoryDir(path: string): string {
  return join(PROJECTS_DIR, projectFolderName(path), 'memory')
}

/** Memory files in the project's own memory folder, not counting the MEMORY.md index. */
async function countMemories(path: string): Promise<number> {
  try {
    const names = await fs.readdir(projectMemoryDir(path))
    return names.filter((n) => /\.md$/i.test(n) && n.toLowerCase() !== 'memory.md').length
  } catch {
    return 0
  }
}

const CACHE_VERSION = 6

/** Per-file scan state; persisted so later scans only read bytes appended since `offset`. */
interface FileIndex {
  size: number
  mtimeMs: number
  /** Byte offset just past the last complete line that was scanned */
  offset: number
  /** Directory the session was started in; sessions are grouped into projects by it */
  firstCwd?: string
  customTitle?: string
  aiTitle?: string
  firstPrompt?: string
  firstCommand?: string
  firstAnswer?: string
  firstPromptTs?: number
  lastTs: number
  promptCount: number
  /** uuids of human prompts; files sharing any of them are copies of the same conversation */
  promptUuids: string[]
  entrypoint?: string
}

interface CacheFile {
  version: number
  files: Record<string, FileIndex>
}

const NL = 0x0a

// Searched as raw bytes: inside JSON string values quotes are escaped, so these only match structural keys.
export const B_USER = Buffer.from('"type":"user"')
export const B_ASSISTANT = Buffer.from('"type":"assistant"')
export const B_TOOL_RESULT = Buffer.from('"type":"tool_result"')
const B_CUSTOM_TITLE = Buffer.from('"type":"custom-title"')
const B_AI_TITLE = Buffer.from('"type":"ai-title"')
const B_TIMESTAMP = Buffer.from('"timestamp":"')
const B_CWD = Buffer.from('"cwd":"')
export const B_SIDECHAIN = Buffer.from('"isSidechain":true')
export const B_TEXT_BLOCK = Buffer.from('"type":"text"')
const B_TOOL_USE = Buffer.from('"type":"tool_use"')
const B_IS_ERROR = Buffer.from('"is_error":true')
const B_EDIT_TOOLS = ['"name":"Edit"', '"name":"MultiEdit"', '"name":"Write"'].map((s) => Buffer.from(s))
const MD_FILE = /\.(md|mdx|markdown)$/i

/** Markdown edit carried by an Edit / MultiEdit / Write tool call; null for anything else. */
function docEdit(b: ContentBlock): DocEdit | null {
  const input = (b.input ?? {}) as Record<string, unknown>
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  if (!MD_FILE.test(path)) return null
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  if (b.name === 'Write') {
    const content = str(input.content)
    return content === null ? null : { path, kind: 'write', hunks: [{ old: '', new: content }] }
  }
  if (b.name === 'Edit') {
    const o = str(input.old_string)
    const n = str(input.new_string)
    return o === null || n === null ? null : { path, kind: 'edit', hunks: [{ old: o, new: n }] }
  }
  if (b.name === 'MultiEdit' && Array.isArray(input.edits)) {
    const hunks = (input.edits as Record<string, unknown>[])
      .map((e) => ({ old: str(e?.old_string), new: str(e?.new_string) }))
      .filter((h): h is { old: string; new: string } => h.old !== null && h.new !== null)
    return hunks.length ? { path, kind: 'edit', hunks } : null
  }
  return null
}
// Local slash commands (/rename, /model …) are logged as system records, not user records.
const B_LOCAL_COMMAND = Buffer.from('"subtype":"local_command"')

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** Reads a file line by line from `start`, calling `onLine` with each complete line's bytes. Returns the offset after the last complete line. */
export async function readLines(file: string, start: number, onLine: (line: Buffer) => void): Promise<number> {
  let carry: Buffer | null = null
  let offset = start
  const stream = createReadStream(file, { start, highWaterMark: 1 << 20 })
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
    let pos = 0
    let nl: number
    while ((nl = buf.indexOf(NL, pos)) !== -1) {
      if (nl > pos) onLine(buf.subarray(pos, nl))
      offset += nl + 1 - pos
      pos = nl + 1
    }
    carry = pos < buf.length ? Buffer.from(buf.subarray(pos)) : null
  }
  return offset
}

function readJsonString(line: Buffer, key: Buffer, fromEnd = false): string | undefined {
  const at = fromEnd ? line.lastIndexOf(key) : line.indexOf(key)
  if (at === -1) return undefined
  const start = at + key.length
  let i = start
  while (i < line.length) {
    const ch = line[i]
    if (ch === 0x5c) i += 2
    else if (ch === 0x22) break
    else i++
  }
  try {
    return JSON.parse('"' + line.toString('utf8', start, i) + '"')
  } catch {
    return undefined
  }
}

function parseTs(s: string | undefined): number {
  if (!s) return 0
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

// ---- record classification -------------------------------------------------

export interface RawRecord {
  type?: string
  uuid?: string
  entrypoint?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  /** `from` is the sender of a peer message, e.g. a subagent id */
  origin?: { kind?: string; from?: string } | null
  timestamp?: string
  cwd?: string
  customTitle?: string
  aiTitle?: string
  /** Set on system records, e.g. local slash commands */
  content?: unknown
  message?: { id?: string; content?: unknown; stop_reason?: string | null }
}

interface ContentBlock {
  type?: string
  text?: string
  /** tool_use */
  id?: string
  name?: string
  input?: unknown
  /** tool_result */
  tool_use_id?: string
  is_error?: boolean
  source?: { type?: string; media_type?: string; data?: string }
}

export function blocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

function userText(r: RawRecord): string {
  return blocks(r.message?.content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** `<command-name>/rename</command-name>…<command-args>x</command-args>` → "/rename x" */
function commandText(raw: string): string | null {
  if (!raw.trimStart().startsWith('<command-')) return null
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw)?.[1]?.trim()
  if (!name) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim()
  const cmd = name.startsWith('/') ? name : '/' + name
  return args ? `${cmd} ${args}` : cmd
}

type UserKind = { kind: 'prompt'; text: string; images: ImageData[] } | { kind: 'command'; text: string } | null

/**
 * Decides whether a `user` record is something the human typed. Newer CLI versions mark typed prompts with
 * origin.kind === "human"; slash commands and older records carry no origin, so those fall back to content checks.
 */
export function classifyUser(r: RawRecord): UserKind {
  if (r.isSidechain || r.isMeta || r.isCompactSummary) return null
  const bs = blocks(r.message?.content)
  if (bs.some((b) => b.type === 'tool_result')) return null
  const raw = userText(r)
  const trimmed = raw.trimStart()

  if (trimmed.startsWith('<command-name>') || trimmed.startsWith('<command-message>')) {
    const text = commandText(raw)
    return text ? { kind: 'command', text } : null
  }
  // `!` shell mode: the typed command shows like a slash command; its output is terminal noise.
  // Neither carries an origin, so they must be caught before the no-origin fallback below.
  if (trimmed.startsWith('<bash-input>')) {
    const cmd = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw)?.[1]?.trim()
    return cmd ? { kind: 'command', text: `! ${cmd}` } : null
  }
  if (trimmed.startsWith('<bash-stdout>') || trimmed.startsWith('<bash-stderr>')) return null

  const kind = r.origin?.kind
  if (kind && kind !== 'human') return null
  if (
    !kind &&
    (trimmed.startsWith('<local-command-') ||
      trimmed.startsWith('<task-notification>') ||
      trimmed.startsWith('[Request interrupted'))
  ) {
    return null
  }

  const text = raw.replace(SYSTEM_REMINDER, '').trim()
  const images: ImageData[] = []
  for (const b of bs) {
    if (b.type === 'image' && b.source?.type === 'base64' && b.source.data) {
      images.push({ mediaType: b.source.media_type || 'image/png', data: b.source.data })
    }
  }
  if (!text && images.length === 0) return null
  return { kind: 'prompt', text, images }
}

// ---- index scan ------------------------------------------------------------

function emptyIndex(): FileIndex {
  return { size: 0, mtimeMs: 0, offset: 0, lastTs: 0, promptCount: 0, promptUuids: [] }
}

async function indexFile(file: string, prev: FileIndex | undefined, size: number, mtimeMs: number): Promise<FileIndex> {
  // A shrunk file was rewritten, so the old offset is meaningless.
  const idx: FileIndex = prev && size >= prev.offset ? { ...prev, promptUuids: [...prev.promptUuids] } : emptyIndex()
  idx.offset = await readLines(file, idx.offset, (line) => {
    if (line.includes(B_CUSTOM_TITLE) || line.includes(B_AI_TITLE)) {
      try {
        const r = JSON.parse(line.toString('utf8')) as RawRecord
        if (r.type === 'custom-title' && r.customTitle) idx.customTitle = r.customTitle
        else if (r.type === 'ai-title' && r.aiTitle) idx.aiTitle = r.aiTitle
      } catch {
        /* partial or malformed line */
      }
      return
    }
    if (line.includes(B_SIDECHAIN)) return
    const isUser = line.includes(B_USER)
    const isCommand = !isUser && line.includes(B_LOCAL_COMMAND)
    if (!isUser && !isCommand && !line.includes(B_ASSISTANT)) return

    if (!idx.firstCwd) idx.firstCwd = readJsonString(line, B_CWD)

    if (isUser || isCommand) {
      if (line.includes(B_TOOL_RESULT)) return
      let r: RawRecord
      try {
        r = JSON.parse(line.toString('utf8'))
      } catch {
        return
      }
      if (!idx.entrypoint && r.entrypoint) idx.entrypoint = r.entrypoint
      const command = isCommand && typeof r.content === 'string' ? commandText(r.content) : null
      const u: UserKind = isCommand ? (command ? { kind: 'command', text: command } : null) : classifyUser(r)
      if (!u) return
      const ts = parseTs(r.timestamp)
      if (ts > idx.lastTs) idx.lastTs = ts
      if (u.kind === 'prompt') {
        idx.promptCount++
        if (r.uuid) idx.promptUuids.push(r.uuid)
        if (!idx.firstPrompt && u.text) {
          idx.firstPrompt = u.text.slice(0, 200)
          idx.firstPromptTs = ts
        }
      } else if (!idx.firstCommand) {
        idx.firstCommand = u.text.slice(0, 200)
      }
    } else {
      // Assistant keys follow `message`, so the last timestamp in the line is the top-level one.
      const ts = parseTs(readJsonString(line, B_TIMESTAMP, true))
      if (ts > idx.lastTs) idx.lastTs = ts
      if (idx.promptCount === 0 && !idx.firstAnswer && line.includes(B_TEXT_BLOCK)) {
        try {
          const r = JSON.parse(line.toString('utf8')) as RawRecord
          idx.firstAnswer = blocks(r.message?.content).find((b) => b.type === 'text' && b.text?.trim())?.text?.trim().slice(0, 200)
        } catch {
          /* partial or malformed line */
        }
      }
    }
  })
  idx.size = size
  idx.mtimeMs = mtimeMs
  return idx
}

function sessionTitle(idx: FileIndex): string {
  const t = idx.customTitle || idx.aiTitle || idx.firstPrompt?.split('\n')[0] || idx.firstCommand || idx.firstAnswer?.split('\n')[0]
  return t?.trim().slice(0, 120) || ''
}

/** Windows paths are case-insensitive and one directory can map to several ~/.claude/projects folders. */
export function projectKeyOf(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase()
}

function similarity(a: string, b: string): number {
  if (a === b) return 1
  const n = a.length
  const m = b.length
  if (!n || !m) return 0
  let prev = Array.from({ length: m + 1 }, (_, j) => j)
  for (let i = 1; i <= n; i++) {
    const cur = [i]
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return 1 - prev[m] / Math.max(n, m)
}

const RESUBMIT_WINDOW_MS = 30 * 60_000

/**
 * Groups session files into conversations:
 * - files sharing a prompt uuid are copies (Claude Desktop copies history, uuids included, into a new file);
 * - files in the same directory whose opening prompts are ≥90% alike and were sent within 30 minutes are
 *   re-submits of one question (e.g. after fixing a typo), which get fresh uuids.
 */
function groupFamilies<T extends { idx: FileIndex; dir: string }>(files: T[]): T[][] {
  const parent = files.map((_, i) => i)
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a: number, b: number): void => {
    parent[root(a)] = root(b)
  }
  const owner = new Map<string, number>()
  files.forEach((f, i) => {
    for (const u of f.idx.promptUuids) {
      const o = owner.get(u)
      if (o === undefined) owner.set(u, i)
      else union(i, o)
    }
  })

  const byStart = files
    .map((f, i) => ({ i, key: projectKeyOf(f.idx.firstCwd || f.dir), ts: f.idx.firstPromptTs || 0, text: (f.idx.firstPrompt || '').replace(/\s+/g, '').slice(0, 80) }))
    .filter((x) => x.ts && x.text.length >= 8)
    .sort((a, b) => a.ts - b.ts)
  for (let a = 0; a < byStart.length; a++) {
    for (let b = a + 1; b < byStart.length && byStart[b].ts - byStart[a].ts <= RESUBMIT_WINDOW_MS; b++) {
      const x = byStart[a]
      const y = byStart[b]
      if (x.key === y.key && root(x.i) !== root(y.i) && similarity(x.text, y.text) >= 0.9) union(x.i, y.i)
    }
  }
  const out = new Map<number, T[]>()
  files.forEach((f, i) => {
    const r = root(i)
    const list = out.get(r)
    if (list) list.push(f)
    else out.set(r, [f])
  })
  return [...out.values()]
}

export const TEMP_PATTERNS = [/\\AppData\\Local\\Temp\\/i, /\\AppData\\Roaming\\Claude\\scratch/i]

export class SessionIndex {
  private cache: CacheFile = { version: CACHE_VERSION, files: {} }
  private running: Promise<ProjectSummary[]> | null = null
  private rerun = false
  private loaded = false
  private cachePath: string

  constructor(cachePath: string) {
    this.cachePath = cachePath
  }

  private async loadCache(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const c = JSON.parse(await fs.readFile(this.cachePath, 'utf8')) as CacheFile
      if (c.version === CACHE_VERSION) this.cache = c
    } catch {
      /* first run or unreadable cache: rebuild */
    }
  }

  /** Coalesces concurrent calls: a call during a scan triggers exactly one follow-up scan. */
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
    await this.loadCache()
    const nextFiles: Record<string, FileIndex> = {}
    const files: { version: SessionVersion; idx: FileIndex; dir: string }[] = []
    let dirs: string[] = []
    try {
      dirs = (await fs.readdir(PROJECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return []
    }

    let changed = false
    for (const dir of dirs) {
      const dirPath = join(PROJECTS_DIR, dir)
      let entries: string[]
      try {
        entries = (await fs.readdir(dirPath, { withFileTypes: true }))
          .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
          .map((e) => e.name)
      } catch {
        continue
      }
      for (const name of entries) {
        const file = join(dirPath, name)
        let st
        try {
          st = await fs.stat(file)
        } catch {
          continue
        }
        const prev = this.cache.files[file]
        let idx: FileIndex
        if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
          idx = await indexFile(file, prev, st.size, st.mtimeMs)
          changed = true
        } else {
          idx = prev
        }
        nextFiles[file] = idx
        if (idx.promptCount === 0 && !idx.firstCommand && !idx.firstAnswer) continue
        files.push({
          dir,
          idx,
          version: {
            id: basename(name, '.jsonl'),
            dir,
            title: sessionTitle(idx),
            lastActivity: idx.lastTs || st.mtimeMs,
            promptCount: idx.promptCount,
          },
        })
      }
    }

    const groups = new Map<string, { path: string; sessions: SessionSummary[] }>()
    for (const family of groupFamilies(files)) {
      // The file with the most prompts is the most complete copy; the newest one may be a short fork.
      const primary = family.reduce((a, b) =>
        b.idx.promptCount > a.idx.promptCount ||
        (b.idx.promptCount === a.idx.promptCount && b.version.lastActivity > a.version.lastActivity)
          ? b
          : a,
      )
      const path = primary.idx.firstCwd || primary.dir
      const key = projectKeyOf(path)
      const versions = family.map((f) => f.version).sort((a, b) => b.lastActivity - a.lastActivity)
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { path, sessions: [] }))
      g.sessions.push({
        ...primary.version,
        projectKey: key,
        familyActivity: versions[0].lastActivity,
        headless: primary.idx.entrypoint === 'sdk-cli' || primary.idx.promptCount === 0,
        versions,
      })
    }

    const projects: ProjectSummary[] = []
    for (const [key, { path, sessions }] of groups) {
      sessions.sort((a, b) => b.familyActivity - a.familyActivity)
      projects.push({
        source: 'claude',
        key,
        path,
        name: basename(path) || path,
        isTemp: TEMP_PATTERNS.some((p) => p.test(path)),
        lastActivity: sessions[0].familyActivity,
        memoryCount: await countMemories(path),
        sessions,
      })
    }

    if (changed || Object.keys(nextFiles).length !== Object.keys(this.cache.files).length) {
      this.cache = { version: CACHE_VERSION, files: nextFiles }
      await fs.writeFile(this.cachePath, JSON.stringify(this.cache)).catch(() => undefined)
    }
    projects.sort((a, b) => b.lastActivity - a.lastActivity)
    return projects
  }
}

// ---- full session load -----------------------------------------------------

/** Finds the conversation that contains `id` (its primary id or any version id). */
export function findSession(
  projects: ProjectSummary[],
  projectKey: string,
  id: string,
): { project: ProjectSummary; family: SessionSummary; version: SessionVersion } | null {
  const project = projects.find((p) => p.key === projectKey)
  for (const family of project?.sessions ?? []) {
    const version = family.versions.find((v) => v.id === id)
    if (version) return { project: project!, family, version }
  }
  return null
}

const B_TOOL_USE_ID = Buffer.from('"tool_use_id":"')
const B_END_TURN = Buffer.from('"stop_reason":"end_turn"')
const B_HANDBACK = Buffer.from('"name":"SubagentHandback"')
// Tool calls shown in the conversation. `Task` is the Agent tool's older name; the closing quote keeps
// `"name":"TaskCreate"` from matching.
const B_ACTIVITY_TOOLS = [...['"name":"mcp__', '"name":"Agent"', '"name":"Task"'].map((s) => Buffer.from(s)), B_HANDBACK]

/** Every tool_use_id in a tool_result line; one user record can carry the results of parallel calls. */
function resultIds(line: Buffer, into: Set<string>): void {
  for (let at = line.indexOf(B_TOOL_USE_ID); at !== -1; at = line.indexOf(B_TOOL_USE_ID, at + 1)) {
    const end = line.indexOf(0x22, at + B_TOOL_USE_ID.length)
    if (end !== -1) into.add(line.toString('utf8', at + B_TOOL_USE_ID.length, end))
  }
}

/** `<id>.meta.json` beside each subagent transcript, keyed by the Agent tool call that started it. */
interface AgentMeta {
  id: string
  description?: string
  agentType?: string
  model?: string
  stoppedByUser?: boolean
  /** 'background' for subagents that run while the parent goes on */
  requestShape?: string
}

const subagentsDir = (dir: string, sessionId: string) => join(PROJECTS_DIR, dir, sessionId, 'subagents')

async function readAgentMetas(dir: string, sessionId: string): Promise<Map<string, AgentMeta>> {
  const out = new Map<string, AgentMeta>()
  const folder = subagentsDir(dir, sessionId)
  let names: string[]
  try {
    names = await fs.readdir(folder)
  } catch {
    return out
  }
  for (const name of names) {
    const m = /^agent-(.+)\.meta\.json$/.exec(name)
    if (!m) continue
    try {
      const meta = JSON.parse(await fs.readFile(join(folder, name), 'utf8')) as Omit<AgentMeta, 'id'> & { toolUseId?: string }
      if (meta.toolUseId) out.set(meta.toolUseId, { ...meta, id: m[1] })
    } catch {
      /* unreadable meta: the card falls back to the tool call's input */
    }
  }
  return out
}

/**
 * Progress of a subagent transcript: its tool calls, and whether its last assistant record finished it, either a
 * reply that ended its turn or the SubagentHandback call that delivers its report.
 */
async function agentProgress(file: string): Promise<{ toolCalls: number; ended: boolean } | null> {
  let toolCalls = 0
  let ended = false
  try {
    await readLines(file, 0, (line) => {
      if (!line.includes(B_ASSISTANT)) return
      const handback = line.includes(B_HANDBACK)
      if (line.includes(B_TOOL_USE) && !handback) toolCalls++
      ended = handback || line.includes(B_END_TURN)
    })
  } catch {
    return null
  }
  return { toolCalls, ended }
}

interface SessionContext {
  dir: string
  /** Session file whose subagents/ folder holds the transcripts */
  sessionId: string
  metas: Map<string, AgentMeta>
}

/**
 * `finished`: the parent got the subagent's result, i.e. the tool result of a foreground call or the
 * completion notification of a background one (whose tool result only says it was launched).
 */
async function agentRun(
  ctx: SessionContext,
  toolUseId: string,
  input: Record<string, unknown>,
  finished: (background: boolean) => boolean,
): Promise<AgentRun> {
  const meta = ctx.metas.get(toolUseId)
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const progress = meta ? await agentProgress(join(subagentsDir(ctx.dir, ctx.sessionId), `agent-${meta.id}.jsonl`)) : null
  const background = meta?.requestShape === 'background' || input.run_in_background === true
  const state: AgentRun['state'] = meta?.stoppedByUser
    ? 'stopped'
    : progress?.ended || finished(background)
      ? 'done'
      : 'open'
  return {
    id: progress ? meta!.id : null,
    description: meta?.description || str(input.description) || '',
    type: meta?.agentType || str(input.subagent_type) || 'general-purpose',
    model: meta?.model || str(input.model),
    state,
    toolCalls: progress?.toolCalls ?? 0,
  }
}

/**
 * Builds the visible turns of a transcript: a session file, or a subagent's (whose records are all sidechain).
 * An assistant turn runs until the next prompt or until Claude ends its turn (`stop_reason` other than
 * `tool_use`); Claude resuming on its own afterwards (a subagent reporting back, a notification) starts a new turn
 * behind a `resume` marker, so each reply the user saw stays a reply instead of folding into the steps.
 */
async function readTurns(
  file: string,
  ctx: SessionContext,
  sidechain: boolean,
): Promise<{ turns: Turn[]; firstTime: number; lastTime: number } | null> {
  const turns: Turn[] = []
  const seenText = new Set<string>()
  let firstTime = 0
  let lastTime = 0
  /** Text of the open assistant turn, split into segments wherever a tool call happened */
  let segments: string[][] | null = null
  let toolSinceText = false
  /** Message id of the reply that ended Claude's turn, while no prompt has followed it */
  let endedMsg: string | null = null
  /** What woke Claude up after that reply */
  let wake: { source: 'agent' | 'message' | 'notification'; from?: string } | null = null

  /** Markdown edits seen so far; kept only if their tool result is not an error (checked at the end). */
  const docEdits: { toolId: string; edit: DocEdit; turn: AssistantTurn }[] = []
  const mcpCalls: { toolId: string; server: string; tool: string; turn: AssistantTurn }[] = []
  const agentCalls: { toolId: string; input: Record<string, unknown>; turn: AssistantTurn }[] = []
  const failedTools = new Set<string>()
  const resolvedTools = new Set<string>()
  /** Tool calls of background tasks reported finished by a task notification */
  const notifiedTools = new Set<string>()
  const seenTools = new Set<string>()

  const closeAssistant = (): void => {
    const last = turns[turns.length - 1]
    if (segments && last?.kind === 'assistant') {
      const parts = segments.map((s) => s.join('\n\n')).filter(Boolean)
      last.text = parts.pop() ?? ''
      last.steps = parts
    }
    segments = null
    toolSinceText = false
    endedMsg = null
    wake = null
  }

  /** The assistant turn currently being built, created on the first text block or tool call worth showing. */
  const openAssistant = (ts: number): AssistantTurn => {
    const last = turns[turns.length - 1]
    if (segments && last?.kind === 'assistant') return last
    segments = []
    toolSinceText = false
    const turn: AssistantTurn = { kind: 'assistant', text: '', steps: [], edits: [], agents: [], mcp: [], time: ts }
    turns.push(turn)
    return turn
  }

  try {
    await readLines(file, 0, (line) => {
      if (!sidechain && line.includes(B_SIDECHAIN)) return
      const isUser = line.includes(B_USER)
      const isCommand = !isUser && line.includes(B_LOCAL_COMMAND)
      if (!isUser && !isCommand && !line.includes(B_ASSISTANT)) return
      if (isUser && line.includes(B_TOOL_RESULT)) {
        resultIds(line, resolvedTools)
        // Only failures need parsing: a failed or rejected edit must not be shown as a change.
        if (!line.includes(B_IS_ERROR)) return
        try {
          const r = JSON.parse(line.toString('utf8')) as RawRecord
          for (const b of blocks(r.message?.content)) {
            if (b.type === 'tool_result' && b.is_error && b.tool_use_id) failedTools.add(b.tool_use_id)
          }
        } catch {
          /* malformed line */
        }
        return
      }
      // Assistant records hold one content block each. A tool call matters as the boundary that separates
      // in-progress commentary from the final answer, and when it is shown: Markdown edits, MCP calls, subagents.
      if (!isUser && !isCommand && !line.includes(B_TEXT_BLOCK)) {
        if (!line.includes(B_TOOL_USE)) return
        if (!B_EDIT_TOOLS.some((n) => line.includes(n)) && !B_ACTIVITY_TOOLS.some((n) => line.includes(n))) {
          if (segments) toolSinceText = true
          return
        }
      }
      let r: RawRecord
      try {
        r = JSON.parse(line.toString('utf8'))
      } catch {
        return
      }
      const ts = parseTs(r.timestamp)
      const markTime = (): void => {
        if (!ts) return
        if (!firstTime || ts < firstTime) firstTime = ts
        if (ts > lastTime) lastTime = ts
      }

      if (isCommand) {
        const text = typeof r.content === 'string' ? commandText(r.content) : null
        if (text) {
          closeAssistant()
          markTime()
          turns.push({ kind: 'command', text, time: ts })
        }
        return
      }

      if (r.type === 'user') {
        if (r.isCompactSummary) {
          closeAssistant()
          turns.push({ kind: 'compact', time: ts })
          return
        }
        // A subagent transcript is all sidechain; its records are the subagent's own conversation.
        const u = classifyUser(sidechain ? { ...r, isSidechain: false } : r)
        if (!u) {
          const kind = r.origin?.kind
          if (kind === 'task-notification') {
            const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(userText(r))?.[1]
            if (id) notifiedTools.add(id)
          }
          if (endedMsg !== null) {
            const from = r.origin?.from
            if (kind === 'peer') wake = { source: from && metaByAgentId(ctx, from) ? 'agent' : 'message', from }
            else if (kind === 'task-notification' && !wake) wake = { source: 'notification' }
          }
          return
        }
        closeAssistant()
        markTime()
        if (u.kind === 'prompt') turns.push({ kind: 'user', text: u.text, images: u.images, time: ts })
        else turns.push({ kind: 'command', text: u.text, time: ts })
        return
      }

      if (r.type !== 'assistant') return
      const msgId = r.message?.id || ''
      if (endedMsg !== null && msgId !== endedMsg) {
        const w = wake
        closeAssistant()
        const agent = w?.source === 'agent' && w.from ? metaByAgentId(ctx, w.from)?.description : undefined
        turns.push({ kind: 'resume', source: w?.source ?? 'other', agent, time: ts })
      }
      for (const b of blocks(r.message?.content)) {
        let text = b.type === 'text' ? b.text : undefined
        if (b.type === 'tool_use') {
          if (b.id && !seenTools.has(b.id)) {
            const edit = docEdit(b)
            const name = b.name ?? ''
            if (edit) {
              seenTools.add(b.id)
              docEdits.push({ toolId: b.id, edit, turn: openAssistant(ts) })
            } else if (name.startsWith('mcp__')) {
              seenTools.add(b.id)
              // mcp__<server>__<tool>; server names can contain single underscores.
              const [server, ...tool] = name.slice(5).split('__')
              mcpCalls.push({ toolId: b.id, server, tool: tool.join('__'), turn: openAssistant(ts) })
            } else if (name === 'Agent' || name === 'Task') {
              seenTools.add(b.id)
              agentCalls.push({ toolId: b.id, input: (b.input ?? {}) as Record<string, unknown>, turn: openAssistant(ts) })
            }
          }
          // A subagent's final report is the input of this call, not a text block.
          const report = b.name === 'SubagentHandback' ? (b.input as { message?: unknown } | undefined)?.message : undefined
          if (typeof report !== 'string') {
            if (segments) toolSinceText = true
            continue
          }
          text = report
        }
        if (!text?.trim()) continue
        // The same block is sometimes written twice under one message id.
        const key = msgId + '\u0000' + text
        if (seenText.has(key)) continue
        seenText.add(key)
        markTime()
        const turn = openAssistant(ts)
        const segs = segments!
        if (toolSinceText || segs.length === 0) segs.push([])
        segs[segs.length - 1].push(text.trim())
        turn.time = ts || turn.time
        toolSinceText = false
        const stop = r.message?.stop_reason
        if (stop && stop !== 'tool_use') endedMsg = msgId
      }
    })
    closeAssistant()
  } catch {
    return null
  }

  for (const { toolId, edit, turn } of docEdits) {
    if (!failedTools.has(toolId)) turn.edits.push(edit)
  }
  for (const { toolId, server, tool, turn } of mcpCalls) {
    const state: McpUse['state'] = failedTools.has(toolId) ? 'error' : resolvedTools.has(toolId) ? 'done' : 'open'
    const same = turn.mcp.find((m) => m.server === server && m.tool === tool)
    if (!same) turn.mcp.push({ server, tool, count: 1, state })
    else {
      same.count++
      // A call still waiting outranks an earlier failure, which outranks success.
      if (state === 'open' || (state === 'error' && same.state === 'done')) same.state = state
    }
  }
  for (const { toolId, input, turn } of agentCalls) {
    const finished = (background: boolean) => (background ? notifiedTools : resolvedTools).has(toolId)
    turn.agents.push(await agentRun(ctx, toolId, input, finished))
  }
  return { turns, firstTime, lastTime }
}

function metaByAgentId(ctx: SessionContext, agentId: string): AgentMeta | undefined {
  for (const m of ctx.metas.values()) if (m.id === agentId) return m
  return undefined
}

// Windows strips trailing dots and spaces; those aliases must not resolve outside a session folder.
export const SAFE_SEGMENT = /^(?!.*[. ]$)[^\\/:<>"|?*\x00-\x1f]+$/

export async function loadSession(
  project: ProjectSummary,
  family: SessionSummary,
  s: SessionVersion,
): Promise<SessionDetail | null> {
  if (!SAFE_SEGMENT.test(s.dir) || !SAFE_SEGMENT.test(s.id)) return null
  const ctx: SessionContext = { dir: s.dir, sessionId: s.id, metas: await readAgentMetas(s.dir, s.id) }
  const read = await readTurns(join(PROJECTS_DIR, s.dir, s.id + '.jsonl'), ctx, false)
  if (!read) return null
  return {
    source: 'claude',
    id: s.id,
    familyId: family.id,
    projectKey: project.key,
    versions: family.versions,
    path: project.path,
    ...read,
  }
}

/** A subagent's conversation, from the subagents/ folder of the session file that started it. */
export async function loadAgent(s: SessionVersion, agentId: string): Promise<AgentDetail | null> {
  if (!SAFE_SEGMENT.test(s.dir) || !SAFE_SEGMENT.test(s.id) || !/^[\w-]+$/.test(agentId)) return null
  const ctx: SessionContext = { dir: s.dir, sessionId: s.id, metas: await readAgentMetas(s.dir, s.id) }
  const entry = [...ctx.metas.entries()].find(([, m]) => m.id === agentId)
  if (!entry) return null
  const read = await readTurns(join(subagentsDir(s.dir, s.id), `agent-${agentId}.jsonl`), ctx, true)
  if (!read) return null
  return { run: await agentRun(ctx, entry[0], {}, () => false), turns: read.turns }
}
