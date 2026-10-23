import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ActionResult,
  ActionError,
  DeleteKind,
  DeleteItem,
  DeletePlan,
  DeleteTarget,
  LiveSessions,
  ProjectSummary,
  SessionVersion,
} from '../shared/types'
import { findSession, projectMemoryDir, PROJECTS_DIR } from './sessions'

const CLAUDE_DIR = join(homedir(), '.claude')

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const LIVE_SESSIONS_DIR = join(CLAUDE_DIR, 'sessions')

/**
 * Sessions open in a running Claude Code process, with whether Claude is working on a turn. Each process
 * writes ~/.claude/sessions/<pid>.json; files left behind by crashed processes are ignored via the pid check.
 * Any status other than "busy" counts as idle.
 */
export async function liveSessions(): Promise<LiveSessions> {
  const live: LiveSessions = {}
  let names: string[] = []
  try {
    names = await fs.readdir(LIVE_SESSIONS_DIR)
  } catch {
    return live
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const s = JSON.parse(await fs.readFile(join(LIVE_SESSIONS_DIR, name), 'utf8')) as {
        pid?: number
        sessionId?: string
        status?: string
      }
      if (s.sessionId && s.pid && pidAlive(s.pid)) live[s.sessionId] = s.status === 'busy' ? 'busy' : 'idle'
    } catch {
      /* being written or malformed */
    }
  }
  return live
}

export async function liveSessionIds(): Promise<Set<string>> {
  return new Set(Object.keys(await liveSessions()))
}

const OPEN_ERROR: ActionError = { code: 'session-open' }

async function sizeOf(path: string): Promise<number | null> {
  let st
  try {
    st = await fs.lstat(path)
  } catch {
    return null
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return st.size
  let total = 0
  const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    total += (await sizeOf(join(path, e.name))) ?? 0
  }
  return total
}

/** Everything that belongs to one session file. Project memory is deliberately not included. */
function versionPaths(v: SessionVersion): { path: string; kind: DeleteKind }[] {
  return [
    { path: join(PROJECTS_DIR, v.dir, v.id + '.jsonl'), kind: 'sessions' },
    { path: join(PROJECTS_DIR, v.dir, v.id), kind: 'artifacts' }, // subagents, tool-results, custom-title.json
    { path: join(CLAUDE_DIR, 'file-history', v.id), kind: 'history' }, // pre-edit backups used by /rewind
    { path: join(CLAUDE_DIR, 'session-env', v.id), kind: 'artifacts' },
    { path: join(tmpdir(), 'claude', v.dir, v.id), kind: 'temp' }, // per-session scratchpad
  ]
}

async function existing(paths: { path: string; kind: DeleteKind }[]): Promise<DeleteItem[]> {
  const out: DeleteItem[] = []
  for (const { path, kind } of paths) {
    const bytes = await sizeOf(path)
    if (bytes !== null) out.push({ path, bytes, kind })
  }
  return out
}

function targetVersions(projects: ProjectSummary[], target: DeleteTarget): SessionVersion[] {
  if (target.kind === 'session') return findSession(projects, target.projectKey, target.id)?.family.versions ?? []
  return projects.find((p) => p.key === target.projectKey)?.sessions.flatMap((s) => s.versions) ?? []
}

export async function planDelete(projects: ProjectSummary[], target: DeleteTarget): Promise<DeletePlan> {
  const versions = targetVersions(projects, target)
  const live = await liveSessionIds()
  const project = projects.find((p) => p.key === target.projectKey)
  // Only the folder Claude Code derives from this project's own path. Copies of a conversation can live in
  // another project's folder, and that folder's memory belongs to the other project.
  const memoryDir: { path: string; kind: DeleteKind }[] =
    target.kind === 'project' && project ? [{ path: projectMemoryDir(project.path), kind: 'memory' }] : []
  const items = await existing([...versions.flatMap(versionPaths), ...memoryDir])
  const blocked = versions.some((v) => live.has(v.id)) ? OPEN_ERROR : undefined
  return { items, blocked }
}

/** The plan is recomputed here and filtered by kind; paths are never taken from the renderer. */
export async function runDelete(
  projects: ProjectSummary[],
  target: DeleteTarget,
  kinds: DeleteKind[],
): Promise<ActionResult> {
  const plan = await planDelete(projects, target)
  if (plan.blocked) return { ok: false, error: plan.blocked }
  const failed: string[] = []
  for (const { path } of plan.items.filter((i) => kinds.includes(i.kind))) {
    try {
      await shell.trashItem(path)
    } catch {
      failed.push(path)
    }
  }
  return failed.length ? { ok: false, error: { code: 'trash-failed', files: failed } } : { ok: true }
}

/**
 * Markers a running Claude Code puts on its child processes. They reach this app when it was started from a
 * Claude Code session; a resumed session that inherits them treats itself as that session's child and turns
 * off transcript saving; CLAUDE_EFFORT would also pin the parent's effort level. The messaging socket and
 * token belong to the parent session only. User settings such as CLAUDE_CONFIG_DIR must pass through, so only
 * these names are removed.
 */
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
]

function withoutParentSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const drop = new Set(PARENT_SESSION_VARS)
  // Windows env names are case-insensitive.
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k.toUpperCase())))
}

/**
 * Opens a Windows Terminal tab in the project directory running `claude --resume`. PowerShell stays open
 * after Claude exits so the tab does not vanish. Only for conversations not already open elsewhere.
 */
export async function openInTerminal(
  projects: ProjectSummary[],
  projectKey: string,
  id: string,
): Promise<ActionResult> {
  const hit = findSession(projects, projectKey, id)
  if (!hit) return { ok: false, error: { code: 'session-missing' } }
  const live = await liveSessionIds()
  if (hit.family.versions.some((v) => live.has(v.id))) return { ok: false, error: OPEN_ERROR }
  const cwd = hit.project.path
  if (!existsSync(cwd)) return { ok: false, error: { code: 'directory-missing', path: cwd } }
  // wt.exe splits its whole command line at ';' into separate tabs; '\;' passes a literal semicolon.
  const wtArg = (s: string) => s.replace(/;/g, '\\;')
  // Resume the primary file: it holds the most complete copy of the conversation.
  const args = ['-d', wtArg(cwd), 'pwsh', '-NoExit', '-Command', `claude --resume ${hit.family.id}`]
  const child = spawn('wt.exe', args, {
    env: withoutParentSession(process.env),
    detached: true,
    stdio: 'ignore',
  })
  return await new Promise<ActionResult>((resolve) => {
    child.once('error', (e) => resolve({ ok: false, error: { code: 'terminal-failed', detail: e.message } }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

/** Mirrors /rename: appends a custom-title record and rewrites <id>/custom-title.json. */
export async function renameSession(
  projects: ProjectSummary[],
  projectKey: string,
  id: string,
  title: string,
): Promise<ActionResult> {
  const name = title.trim()
  if (!name) return { ok: false, error: { code: 'name-empty' } }
  const hit = findSession(projects, projectKey, id)
  if (!hit) return { ok: false, error: { code: 'session-missing' } }
  // The list shows the primary file's title, so that is the file to rename.
  const v = hit.family.versions.find((x) => x.id === hit.family.id) ?? hit.version
  // A running session re-appends its in-memory title and would undo the rename.
  if ((await liveSessionIds()).has(v.id)) return { ok: false, error: OPEN_ERROR }

  const file = join(PROJECTS_DIR, v.dir, v.id + '.jsonl')
  try {
    const fh = await fs.open(file, 'r')
    let lead = ''
    try {
      const { size } = await fh.stat()
      if (size > 0) {
        const last = Buffer.alloc(1)
        await fh.read(last, 0, 1, size - 1)
        if (last[0] !== 0x0a) lead = '\n'
      }
    } finally {
      await fh.close()
    }
    await fs.appendFile(file, lead + JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: v.id }) + '\n')
    const dir = join(PROJECTS_DIR, v.dir, v.id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'custom-title.json'), JSON.stringify({ customTitle: name }))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { code: 'rename-failed', detail: (e as Error).message } }
  }
}
