import { existsSync, promises as fs, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ProjectSummary, SessionDetail, SessionSummary, SessionVersion } from '../shared/types'
import { projectKeyOf, TEMP_PATTERNS } from './sessions'

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')
/** Codex Desktop's own state: projects, thread assignments and per-thread UI entries keyed by thread id */
export const CODEX_GLOBAL_STATE = join(CODEX_HOME, '.codex-global-state.json')

const KEY_PREFIX = 'codex:'
export const isCodexKey = (key: string): boolean => key.startsWith(KEY_PREFIX)
const PROJECTLESS_KEY = KEY_PREFIX + 'projectless'

/** The thread index database; its file name carries a schema number (`state_5.sqlite`). */
export function codexStateDb(): string | null {
  let names: string[]
  try {
    names = readdirSync(CODEX_HOME)
  } catch {
    return null
  }
  const dbs = names
    .map((n) => /^state_(\d+)\.sqlite$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  return dbs.length ? join(CODEX_HOME, dbs[0][0]) : null
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

function openDb(): DatabaseSync | null {
  const path = codexStateDb()
  if (!path) return null
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

/** Top-level threads; subagent threads carry a JSON `source` and are listed with their parent. */
function readThreads(db: DatabaseSync): CodexThread[] {
  const rows = db
    .prepare(
      `SELECT id, rollout_path, created_at, updated_at, source, cwd, title, first_user_message, archived
       FROM threads WHERE source NOT LIKE '{%'`,
    )
    .all() as {
    id: string
    rollout_path: string
    created_at: number
    updated_at: number
    source: string
    cwd: string
    title: string | null
    first_user_message: string | null
    archived: number
  }[]
  return rows.map((r) => ({
    id: r.id,
    rolloutPath: r.rollout_path,
    created: r.created_at * 1000,
    updated: r.updated_at * 1000,
    source: r.source,
    cwd: r.cwd,
    title: (r.title || r.first_user_message?.split('\n')[0] || '').trim().slice(0, 120),
    archived: !!r.archived,
  }))
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
    const row = db.prepare('SELECT id, rollout_path, created_at, updated_at, source, cwd, title, archived FROM threads WHERE id = ?')
    while (frontier.length) {
      const next: string[] = []
      for (const id of frontier) {
        for (const { child_thread_id: child } of edges.all(id) as { child_thread_id: string }[]) {
          if (seen.has(child)) continue
          seen.add(child)
          next.push(child)
          const r = row.get(child) as Record<string, unknown> | undefined
          if (r) {
            out.push({
              id: child,
              rolloutPath: String(r.rollout_path ?? ''),
              created: Number(r.created_at) * 1000,
              updated: Number(r.updated_at) * 1000,
              source: String(r.source ?? ''),
              cwd: String(r.cwd ?? ''),
              title: String(r.title ?? ''),
              archived: !!r.archived,
            })
          }
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
    return readThreads(db).find((t) => t.id === id) ?? null
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
    const version: SessionVersion = { id: t.id, dir: '', title: t.title, lastActivity: t.updated, promptCount: 0 }
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

/** Codex conversations are not shown here, only what identifies them; their content stays in Codex Desktop. */
export function loadCodexSession(project: ProjectSummary, family: SessionSummary): SessionDetail | null {
  const t = codexThread(family.id)
  if (!t) return null
  return {
    source: 'codex',
    id: t.id,
    familyId: family.id,
    projectKey: project.key,
    versions: family.versions,
    path: t.cwd,
    turns: [],
    firstTime: t.created,
    lastTime: t.updated,
    codex: { cwd: t.cwd, archived: t.archived, subagents: codexDescendants([t.id]).length },
  }
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
