import { existsSync, promises as fs, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentDetail, AgentRun, ImageData, McpUse, ProjectSummary, SessionDetail, SessionSummary, SessionVersion, Turn } from '../shared/types'
import { projectKeyOf, TEMP_PATTERNS } from './sessions'

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')
/** Codex Desktop's own state: projects, thread assignments and per-thread UI entries keyed by thread id */
export const CODEX_GLOBAL_STATE = join(CODEX_HOME, '.codex-global-state.json')

const KEY_PREFIX = 'codex:'
export const isCodexKey = (key: string): boolean => key.startsWith(KEY_PREFIX)
const PROJECTLESS_KEY = KEY_PREFIX + 'projectless'

/** Codex databases carry a schema number in their file name (`state_5.sqlite`); the highest one is current. */
function codexDb(prefix: 'state' | 'thread_history'): string | null {
  let names: string[]
  try {
    names = readdirSync(CODEX_HOME)
  } catch {
    return null
  }
  const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`)
  const dbs = names
    .map((n) => pattern.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  return dbs.length ? join(CODEX_HOME, dbs[0][0]) : null
}

/** Codex records some working folders with the `\\?\` long-path prefix; compare and show them without it. */
export function plainPath(path: string): string {
  return path.startsWith('\\\\?\\UNC\\') ? '\\\\' + path.slice(8) : path.startsWith('\\\\?\\') ? path.slice(4) : path
}

/**
 * Codex Desktop sends attachments ahead of the prompt as "# Files mentioned by the user: … ## My request for
 * Codex:" (older versions: "## My request:"); only the request is the prompt.
 */
export function codexRequest(text: string): string {
  const marker = /^## My request[^:\n]*:[ \t]*/m.exec(text)
  return text.trimStart().startsWith('# Files mentioned by the user') && marker ? text.slice(marker.index + marker[0].length).trim() : text
}

/** Codex Desktop installs its CLI under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\; old hash folders may be empty. */
export function codexExecutable(): string {
  const bin = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')
  try {
    const found = readdirSync(bin)
      .map((d) => join(bin, d, 'codex.exe'))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    if (found.length) return found[0]
  } catch {
    /* no Desktop install */
  }
  return 'codex'
}

export interface CodexThread {
  id: string
  rolloutPath: string
  /** Epoch ms */
  created: number
  updated: number
  source: string
  cwd: string
  title: string
  archived: boolean
}

interface GlobalState {
  'local-projects'?: Record<string, { id?: string; name?: string; rootPaths?: string[] }>
  'thread-project-assignments'?: Record<string, { projectId?: string }>
  'projectless-thread-ids'?: string[]
  'thread-projectless-output-directories'?: Record<string, string>
}

export async function readGlobalState(): Promise<GlobalState> {
  try {
    return JSON.parse(await fs.readFile(CODEX_GLOBAL_STATE, 'utf8')) as GlobalState
  } catch {
    return {}
  }
}

function openDb(prefix: 'state' | 'thread_history' = 'state'): DatabaseSync | null {
  const path = codexDb(prefix)
  if (!path) return null
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

const THREAD_COLUMNS = 'id, rollout_path, created_at, updated_at, source, cwd, title, first_user_message, archived'

interface ThreadRow {
  id: string
  rollout_path: string
  created_at: number
  updated_at: number
  source: string
  cwd: string
  title: string | null
  first_user_message: string | null
  archived: number
}

function rowToThread(r: ThreadRow): CodexThread {
  return {
    id: r.id,
    rolloutPath: r.rollout_path ?? '',
    created: r.created_at * 1000,
    updated: r.updated_at * 1000,
    source: r.source,
    cwd: plainPath(r.cwd ?? ''),
    title: codexRequest(r.title || r.first_user_message || '').split('\n')[0].trim().slice(0, 120),
    archived: !!r.archived,
  }
}

/** Top-level threads; subagent threads carry a JSON `source` and are listed with their parent. */
function readThreads(db: DatabaseSync): CodexThread[] {
  const rows = db.prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE source NOT LIKE '{%'`).all() as unknown as ThreadRow[]
  return rows.map(rowToThread)
}

/** Every subagent thread below the given threads, at any depth. */
export function codexDescendants(ids: string[]): CodexThread[] {
  const db = openDb()
  if (!db) return []
  try {
    const out: CodexThread[] = []
    const seen = new Set(ids)
    let frontier = ids
    const edges = db.prepare('SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?')
    const row = db.prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`)
    while (frontier.length) {
      const next: string[] = []
      for (const id of frontier) {
        for (const { child_thread_id: child } of edges.all(id) as { child_thread_id: string }[]) {
          if (seen.has(child)) continue
          seen.add(child)
          next.push(child)
          const r = row.get(child) as ThreadRow | undefined
          if (r) out.push(rowToThread(r))
        }
      }
      frontier = next
    }
    return out
  } finally {
    db.close()
  }
}

export function codexThread(id: string): CodexThread | null {
  const db = openDb()
  if (!db) return null
  try {
    const r = db.prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined
    return r ? rowToThread(r) : null
  } finally {
    db.close()
  }
}

/** Under a root path, compared case-insensitively as Windows paths are. */
function within(path: string, root: string): boolean {
  const p = projectKeyOf(path)
  const r = projectKeyOf(root)
  return p === r || p.startsWith(r + '\\') || p.startsWith(r + '/')
}

/**
 * Threads grouped like Codex Desktop's sidebar: by the Desktop project they are assigned to (or whose root holds
 * their working directory), projectless threads together, anything else (CLI runs) by working directory.
 */
export async function scanCodex(): Promise<ProjectSummary[]> {
  const db = openDb()
  if (!db) return []
  let threads: CodexThread[]
  try {
    threads = readThreads(db)
  } catch {
    return []
  } finally {
    db.close()
  }
  const state = await readGlobalState()
  const names = await threadNames()
  const projects = Object.values(state['local-projects'] ?? {}).filter((p) => p.id && p.rootPaths?.length)
  const assignments = state['thread-project-assignments'] ?? {}
  const projectless = new Set(state['projectless-thread-ids'] ?? [])

  const groups = new Map<string, { path: string; name: string; projectless?: boolean; sessions: SessionSummary[] }>()
  for (const t of threads) {
    const assigned = projects.find((p) => p.id === assignments[t.id]?.projectId)
    const project = assigned ?? projects.find((p) => p.rootPaths!.some((r) => within(t.cwd, r)))
    let key: string
    let group: { path: string; name: string; projectless?: boolean }
    if (project) {
      key = KEY_PREFIX + 'project:' + project.id
      group = { path: project.rootPaths![0], name: project.name || basename(project.rootPaths![0]) }
    } else if (projectless.has(t.id)) {
      key = PROJECTLESS_KEY
      group = { path: '', name: '', projectless: true }
    } else {
      key = KEY_PREFIX + projectKeyOf(t.cwd)
      group = { path: t.cwd, name: basename(t.cwd) || t.cwd }
    }
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { ...group, sessions: [] }))
    const version: SessionVersion = { id: t.id, dir: '', title: names.get(t.id) || t.title, lastActivity: t.updated, promptCount: 0 }
    g.sessions.push({
      ...version,
      projectKey: key,
      familyActivity: t.updated,
      headless: t.source === 'exec',
      versions: [version],
      archived: t.archived,
    })
  }
  const out: ProjectSummary[] = []
  for (const [key, g] of groups) {
    g.sessions.sort((a, b) => b.familyActivity - a.familyActivity)
    out.push({
      source: 'codex',
      key,
      path: g.path,
      name: g.name,
      projectless: g.projectless,
      isTemp: !g.projectless && TEMP_PATTERNS.some((p) => p.test(g.path)),
      lastActivity: g.sessions[0].familyActivity,
      memoryCount: 0,
      sessions: g.sessions,
    })
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity)
}

/** Thread names as Codex Desktop shows them (`/rename` or generated), latest entry per thread. */
async function threadNames(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let text = ''
  try {
    text = await fs.readFile(join(CODEX_HOME, 'session_index.jsonl'), 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line) as { id?: string; thread_name?: string }
      if (r.id && r.thread_name) out.set(r.id, r.thread_name.trim().slice(0, 120))
    } catch {
      /* partial line */
    }
  }
  return out
}

interface ItemRow {
  turn_id: string
  item_type: string
  item_json: string
  created_at_ms: number
}

interface CodexItem {
  content?: { type?: string; text?: string; path?: string; url?: string }[]
  text?: string
  phase?: string
  server?: string
  tool?: string
  status?: string
  agentThreadId?: string
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** A pasted image is a temporary file that may be gone; a data URL carries the image itself. */
function promptImage(c: { type?: string; path?: string; url?: string }): ImageData | null {
  try {
    if (c.type === 'localImage' && c.path && IMAGE_TYPES[extname(c.path).toLowerCase()] && statSync(c.path).size <= MAX_IMAGE_BYTES) {
      return { mediaType: IMAGE_TYPES[extname(c.path).toLowerCase()], data: readFileSync(c.path).toString('base64') }
    }
    const m = c.type === 'image' && c.url ? /^data:([^;]+);base64,(.*)$/s.exec(c.url) : null
    return m ? { mediaType: m[1], data: m[2] } : null
  } catch {
    return null
  }
}

const TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'])

/** Subagent threads a thread started directly, keyed by thread id. */
function codexAgentRuns(parentId: string): Map<string, AgentRun> {
  const out = new Map<string, AgentRun>()
  const state = openDb()
  if (!state) return out
  const history = openDb('thread_history')
  try {
    const children = state
      .prepare(
        `SELECT t.id, t.source, t.model FROM thread_spawn_edges e JOIN threads t ON t.id = e.child_thread_id
         WHERE e.parent_thread_id = ?`,
      )
      .all(parentId) as { id: string; source: string; model: string | null }[]
    const lastTurn = history?.prepare('SELECT status FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1')
    const toolCalls = history?.prepare(
      `SELECT COUNT(*) AS n FROM thread_items WHERE thread_id = ? AND item_type IN (${[...TOOL_ITEMS].map(() => '?').join(', ')})`,
    )
    for (const c of children) {
      let spawn: { agent_path?: string | null; agent_nickname?: string | null; agent_role?: string | null } = {}
      try {
        spawn = JSON.parse(c.source)?.subagent?.thread_spawn ?? {}
      } catch {
        /* not JSON */
      }
      const last = lastTurn?.get(c.id) as { status: string } | undefined
      const calls = toolCalls?.get(c.id, ...TOOL_ITEMS) as { n: number } | undefined
      out.set(c.id, {
        id: c.id,
        description: spawn.agent_path?.split('/').pop() || spawn.agent_nickname || '',
        type: spawn.agent_role || spawn.agent_nickname || 'subagent',
        model: c.model ?? undefined,
        state: last?.status === 'completed' ? 'done' : last && last.status !== 'inProgress' ? 'stopped' : 'open',
        toolCalls: calls?.n ?? 0,
      })
    }
  } catch {
    /* schema changed: no subagents shown */
  } finally {
    state.close()
    history?.close()
  }
  return out
}

/**
 * Visible turns of a Codex thread, from Codex's own history projection (`thread_history_<n>.sqlite`): prompts,
 * and per turn the `final_answer` message with the `commentary` messages before it as steps. A turn that starts
 * without a prompt (a subagent reporting back, a queued follow-up) gets a `resume` marker.
 */
function readCodexTurns(
  threadId: string,
  images = true,
  agents?: Map<string, AgentRun>,
): { turns: Turn[]; firstTime: number; lastTime: number } | null {
  const db = openDb('thread_history')
  if (!db) return null
  let rows: ItemRow[]
  try {
    rows = db
      .prepare('SELECT turn_id, item_type, item_json, created_at_ms FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal')
      .all(threadId) as unknown as ItemRow[]
  } catch {
    return null
  } finally {
    db.close()
  }
  agents ??= codexAgentRuns(threadId)
  const turns: Turn[] = []
  let firstTime = 0
  let lastTime = 0
  let assistant: Extract<Turn, { kind: 'assistant' }> | null = null
  let messages: { text: string; final: boolean }[] = []
  let turnId: string | null = null
  let prompted = false
  const seenAgents = new Set<string>()

  const close = (): void => {
    if (assistant) {
      const finals = messages.filter((m) => m.final)
      const final = finals.length ? finals[finals.length - 1] : messages[messages.length - 1]
      assistant.text = final?.text ?? ''
      assistant.steps = messages.filter((m) => m !== final).map((m) => m.text)
    }
    assistant = null
    messages = []
  }
  const open = (ts: number): Extract<Turn, { kind: 'assistant' }> => {
    if (assistant) return assistant
    if (!prompted && turns.length) turns.push({ kind: 'resume', source: 'other', time: ts })
    prompted = true
    assistant = { kind: 'assistant', text: '', steps: [], edits: [], agents: [], mcp: [], time: ts }
    turns.push(assistant)
    return assistant
  }

  for (const row of rows) {
    let item: CodexItem
    try {
      item = JSON.parse(row.item_json) as CodexItem
    } catch {
      continue
    }
    const ts = row.created_at_ms || 0
    if (ts) {
      if (!firstTime || ts < firstTime) firstTime = ts
      if (ts > lastTime) lastTime = ts
    }
    if (row.turn_id !== turnId) {
      close()
      turnId = row.turn_id
      prompted = false
    }
    switch (row.item_type) {
      case 'userMessage': {
        close()
        const parts = item.content ?? []
        const text = codexRequest(parts.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')).trim()
        const pics = images ? parts.map(promptImage).filter((i): i is ImageData => !!i) : []
        if (text || pics.length) turns.push({ kind: 'user', text, images: pics, time: ts })
        prompted = true
        break
      }
      case 'agentMessage': {
        if (!item.text?.trim()) break
        const turn = open(ts)
        messages.push({ text: item.text.trim(), final: item.phase === 'final_answer' })
        turn.time = ts || turn.time
        break
      }
      case 'mcpToolCall': {
        const turn = open(ts)
        const state: McpUse['state'] = item.status === 'completed' ? 'done' : item.status === 'failed' ? 'error' : 'open'
        const same = turn.mcp.find((m) => m.server === item.server && m.tool === item.tool)
        if (!same) turn.mcp.push({ server: item.server ?? '', tool: item.tool ?? '', count: 1, state })
        else {
          same.count++
          if (state === 'open' || (state === 'error' && same.state === 'done')) same.state = state
        }
        break
      }
      case 'subAgentActivity': {
        const id = item.agentThreadId
        if (!id || seenAgents.has(id)) break
        seenAgents.add(id)
        open(ts).agents.push(agents!.get(id) ?? { id: null, description: '', type: 'subagent', state: 'open', toolCalls: 0 })
        break
      }
      case 'contextCompaction':
        close()
        turns.push({ kind: 'compact', time: ts })
        break
    }
  }
  close()
  return { turns, firstTime, lastTime }
}

export function loadCodexSession(project: ProjectSummary, family: SessionSummary): SessionDetail | null {
  const t = codexThread(family.id)
  const read = t ? readCodexTurns(t.id) : null
  if (!t || !read) return null
  return {
    source: 'codex',
    id: t.id,
    familyId: family.id,
    projectKey: project.key,
    versions: family.versions,
    path: t.cwd,
    ...read,
    firstTime: read.firstTime || t.created,
    lastTime: read.lastTime || t.updated,
  }
}

/** A subagent thread anywhere below thread `rootId`; its card comes from the thread that started it. */
export function loadCodexAgent(rootId: string, agentId: string): AgentDetail | null {
  const db = openDb()
  let parent: string | undefined
  try {
    const below = new Set(codexDescendants([rootId]).map((t) => t.id))
    const edge = below.has(agentId)
      ? (db?.prepare('SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?').get(agentId) as { parent_thread_id: string } | undefined)
      : undefined
    parent = edge?.parent_thread_id
  } finally {
    db?.close()
  }
  const run = parent ? codexAgentRuns(parent).get(agentId) : undefined
  const read = run ? readCodexTurns(agentId) : null
  return run && read ? { run, turns: read.turns } : null
}

/**
 * Newest history row per thread. Search keys its cached text on this rather than on the rollout file, because
 * the text comes from the history projection, which can lag behind the rollout.
 */
export function codexHistoryMarks(): Map<string, number> {
  const out = new Map<string, number>()
  const db = openDb('thread_history')
  if (!db) return out
  try {
    for (const r of db.prepare('SELECT thread_id, MAX(rollout_ordinal) AS n FROM thread_items GROUP BY thread_id').all() as {
      thread_id: string
      n: number
    }[]) {
      out.set(r.thread_id, r.n)
    }
  } catch {
    /* schema changed */
  } finally {
    db.close()
  }
  return out
}

/** Prompts and answer text of a thread, the same text the viewer shows, for content search. */
export function codexSearchText(threadId: string): string[] {
  const out: string[] = []
  for (const t of readCodexTurns(threadId, false, new Map())?.turns ?? []) {
    if (t.kind === 'user' && t.text) out.push(t.text)
    else if (t.kind === 'assistant') out.push(...t.steps, ...(t.text ? [t.text] : []))
  }
  return out
}

/**
 * Removes every trace of the given thread ids from Codex Desktop's state: object keys and list items that
 * mention one. Desktop's own markers for threads it deleted stay. Desktop keeps per-thread entries (descriptions, workspace hints, output folders, sidebar order)
 * and does not prune them for threads deleted elsewhere.
 */
export function forgetThreads(value: unknown, ids: string[]): { value: unknown; removed: number } {
  let removed = 0
  const mentions = (s: string) => ids.some((id) => s.includes(id))
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const kept = v.filter((x) => {
        // An object item goes when one of its own string fields names the thread; deeper mentions are pruned inside it.
        const hit =
          typeof x === 'string'
            ? mentions(x)
            : !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).some((f) => typeof f === 'string' && mentions(f))
        if (hit) removed++
        return !hit
      })
      return kept.map(walk)
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) {
        if (mentions(k) && !k.startsWith(DELETED_MARKER)) {
          removed++
          continue
        }
        out[k] = walk(x)
      }
      return out
    }
    return v
  }
  return { value: walk(value), removed }
}

/**
 * Codex Desktop gives each projectless chat its own working folder, `<root>\<date>\<slug>` (default root
 * `Documents\Codex`), with the outputs inside. The roots come from the output folders Desktop records for its projectless chats. `used` tells whether any indexed thread works in or below a folder.
 */
export async function projectlessWorkspaces(state: GlobalState): Promise<{ all: string[]; used: (dir: string) => boolean; contains: (path: string) => string | null }> {
  const db = openDb()
  let cwds: string[] = []
  try {
    cwds = db ? (db.prepare('SELECT cwd FROM threads').all() as { cwd: string }[]).map((r) => plainPath(r.cwd ?? '')) : []
  } finally {
    db?.close()
  }
  const roots = new Set<string>()
  for (const out of Object.values(state['thread-projectless-output-directories'] ?? {})) roots.add(dirname(dirname(dirname(plainPath(out)))))
  const all: string[] = []
  for (const r of roots) {
    for (const day of await dirNamesOf(r)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      for (const slug of await dirNamesOf(join(r, day))) all.push(join(r, day, slug))
    }
  }
  const used = (dir: string) => cwds.some((c) => within(c, dir))
  const contains = (path: string) => all.find((dir) => within(path, dir) && projectKeyOf(plainPath(path)) === projectKeyOf(dir)) ?? null
  return { all, used, contains }
}

async function dirNamesOf(path: string): Promise<string[]> {
  try {
    return (await fs.readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Desktop's key for a thread it deleted itself; its purpose is undocumented, so it is never removed. */
const DELETED_MARKER = 'codex-writing-block-deleted-thread-v1:'

const THREAD_ID = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g
/**
 * `rollout-<time>-<thread>.jsonl[.zst]`. Some files carry a second id (`<thread>_<other>`); they belong to the
 * first thread, and Codex's history projection has rows for the second id.
 */
const ROLLOUT_FILE = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f-]{36}))?\.jsonl(\.zst)?$/

/** Leftovers of threads that are no longer in Codex's index, and so not listed. */
export interface CodexResidue {
  /** Rollout files without an index row; Codex's thread/delete still finds them by id */
  rollouts: { id: string; path: string }[]
  /** Deleted threads still named in Desktop's state file or the name index */
  stateIds: string[]
  /** Output folders of deleted projectless threads, and generated images of deleted threads */
  folders: { path: string; kind: 'output' | 'artifacts' }[]
}

/** A rollout file, the thread it belongs to, and the second id some file names carry */
export interface RolloutFile {
  id: string
  other?: string
  path: string
}

async function walkRollouts(dir: string, out: RolloutFile[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const path = join(dir, e.name)
    if (e.isDirectory()) await walkRollouts(path, out)
    else {
      const m = ROLLOUT_FILE.exec(e.name)
      if (m) out.push({ id: m[1], other: m[2], path })
    }
  }
}

/** Every rollout file with the thread it belongs to. */
export async function codexRolloutFiles(): Promise<RolloutFile[]> {
  const files: RolloutFile[] = []
  await walkRollouts(join(CODEX_HOME, 'sessions'), files)
  await walkRollouts(join(CODEX_HOME, 'archived_sessions'), files)
  return files
}

/**
 * Finds what deleted threads left behind. A thread id in Desktop's state counts as deleted only with evidence that
 * it was a local thread: Desktop marked it deleted, or assigned it to a local project or the projectless group.
 * Ids that Desktop's cloud and automation features (`aeon-`, `cloud-aeon-`, `orbit-` entries) refer to are left
 * alone: those threads may live outside this machine's index.
 */
export async function scanCodexResidue(): Promise<CodexResidue> {
  const db = openDb()
  if (!db) return { rollouts: [], stateIds: [], folders: [] }
  let live: Set<string>
  try {
    live = new Set((db.prepare('SELECT id FROM threads').all() as { id: string }[]).map((r) => r.id))
  } finally {
    db.close()
  }
  const rollouts = (await codexRolloutFiles()).filter((f) => !live.has(f.id))

  const state = (await readGlobalState()) as Record<string, unknown>
  const atoms = (state['electron-persisted-atom-state'] ?? {}) as Record<string, unknown>
  const ids = (text: string) => text.match(THREAD_ID) ?? []
  const keysOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [])
  const named = new Set<string>()
  for (const [k, v] of Object.entries(state)) if (k.startsWith('thread-')) for (const id of keysOf(v)) named.add(id)
  for (const id of (state['projectless-thread-ids'] as string[] | undefined) ?? []) named.add(id)
  const deleted = new Set<string>()
  const remote = new Set<string>()
  for (const [k, v] of Object.entries(atoms)) {
    if (k.startsWith(DELETED_MARKER)) deleted.add(k.slice(DELETED_MARKER.length))
    else if (/^(aeon-|cloud-aeon|orbit-)/.test(k)) for (const id of ids(k + JSON.stringify(v))) remote.add(id)
    else if (k.includes('thread')) for (const id of [...ids(k), ...keysOf(v)]) named.add(id)
  }
  for (const id of (await threadNames()).keys()) named.add(id)
  const local = new Set([
    ...keysOf(state['thread-project-membership-host-ids']),
    ...keysOf(state['thread-project-assignments']),
    ...keysOf(state['thread-projectless-output-directories']),
    ...((state['projectless-thread-ids'] as string[] | undefined) ?? []),
  ])
  const isThreadId = (id: string) => new RegExp(`^${THREAD_ID.source}$`).test(id)
  const stateIds = [...named].filter((id) => isThreadId(id) && !live.has(id) && !remote.has(id) && (deleted.has(id) || local.has(id)))

  const folders: CodexResidue['folders'] = []
  const workspaces = await projectlessWorkspaces(state as GlobalState)
  for (const dir of workspaces.all) if (!workspaces.used(dir)) folders.push({ path: dir, kind: 'output' })
  try {
    for (const name of await fs.readdir(join(CODEX_HOME, 'generated_images'))) {
      if (!live.has(name) && /^[0-9a-f-]{36}$/.test(name)) folders.push({ path: join(CODEX_HOME, 'generated_images', name), kind: 'artifacts' })
    }
  } catch {
    /* no generated images */
  }
  return { rollouts, stateIds, folders }
}

/** Ids of indexed threads, subagents included, that work in or below a folder. */
export function codexThreadsIn(dir: string): string[] {
  const db = openDb()
  if (!db) return []
  try {
    return (db.prepare('SELECT id, cwd FROM threads').all() as { id: string; cwd: string }[])
      .filter((r) => within(plainPath(r.cwd ?? ''), dir))
      .map((r) => r.id)
  } finally {
    db.close()
  }
}
