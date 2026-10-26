import { existsSync, promises as fs, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
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
 * mention one. Desktop keeps per-thread entries (descriptions, workspace hints, output folders, sidebar order)
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
        if (mentions(k)) {
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
