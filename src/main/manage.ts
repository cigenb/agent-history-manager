import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
import {
  CODEX_GLOBAL_STATE,
  CODEX_HOME,
  codexDescendants,
  codexExecutable,
  codexThread,
  forgetThreads,
  isCodexKey,
  codexRolloutFiles,
  codexThreadsIn,
  projectlessWorkspaces,
  readGlobalState,
  scanCodexResidue,
  type CodexThread,
} from './codex'
import { GROK_HOME, grokDescendants, grokExecutable, grokSessionDir, isGrokKey, scanGrokResidue } from './grok'
import { classifyUser, findSession, projectMemoryDir, PROJECTS_DIR, readLines, type RawRecord } from './sessions'

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
export async function liveSessions(strict = false): Promise<LiveSessions> {
  const live: LiveSessions = {}
  let names: string[] = []
  try {
    names = await fs.readdir(LIVE_SESSIONS_DIR)
  } catch (e) {
    if (strict && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
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
    } catch (e) {
      if (strict && pidAlive(Number(name.slice(0, -5)))) throw e
    }
  }
  return live
}

export async function liveSessionIds(): Promise<Set<string>> {
  return new Set(Object.keys(await liveSessions(true)))
}

const OPEN_ERROR: ActionError = { code: 'session-open' }

let reportProgress: (done: number, total: number) => void = () => {}

/** Receives how many of the paths of the running deletion have been handled. */
export function onDeleteProgress(cb: (done: number, total: number) => void): void {
  reportProgress = cb
}

/**
 * Moves paths to the Recycle Bin a few at a time (each move takes a fraction of a second, and a leftover check
 * can list hundreds), reporting progress. Folders emptied by it are removed afterwards when `pruneParents` is set;
 * rmdir refuses a folder that still has files. Returns the paths that could not be moved.
 */
async function trashPaths(paths: string[], pruneParents = false): Promise<string[]> {
  const failed: string[] = []
  let next = 0
  let done = 0
  reportProgress(0, paths.length)
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++]
      await shell.trashItem(path).catch(() => failed.push(path))
      reportProgress(++done, paths.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, paths.length) }, worker))
  if (pruneParents) for (const dir of new Set(paths.map((p) => dirname(p)))) await fs.rmdir(dir).catch(() => undefined)
  return failed
}

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
  const seen = new Set<string>()
  for (const { path, kind } of paths) {
    if (seen.has(path.toLowerCase())) continue
    seen.add(path.toLowerCase())
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
  if (target.kind === 'residue') {
    if (isGrokKey(target.projectKey)) return (await planGrokResidue(projects)).plan
    return isCodexKey(target.projectKey) ? (await planCodexResidue()).plan : (await planClaudeResidue(projects)).plan
  }
  if (isGrokKey(target.projectKey)) return planGrokDelete(projects, target)
  if (isCodexKey(target.projectKey)) return (await planCodexDelete(projects, target)).plan
  const versions = targetVersions(projects, target)
  const project = projects.find((p) => p.key === target.projectKey)
  // Only the folder Claude Code derives from this project's own path. Copies of a conversation can live in
  // another project's folder, and that folder's memory belongs to the other project.
  const memoryDir: { path: string; kind: DeleteKind }[] =
    target.kind === 'project' && project && !projects.some((p) =>
      p.source === 'claude' && p.key !== project.key && projectMemoryDir(p.path).toLowerCase() === projectMemoryDir(project.path).toLowerCase(),
    ) ? [{ path: projectMemoryDir(project.path), kind: 'memory' }] : []
  const items = await existing([...versions.flatMap(versionPaths), ...memoryDir])
  const live = await liveSessionIds()
  const blocked = versions.some((v) => live.has(v.id)) ? OPEN_ERROR : undefined
  return { items, blocked }
}

/** The plan is recomputed here and filtered by kind; paths are never taken from the renderer. */
export async function runDelete(
  projects: ProjectSummary[],
  target: DeleteTarget,
  kinds: DeleteKind[],
): Promise<ActionResult> {
  if (target.kind === 'residue') {
    if (isGrokKey(target.projectKey)) return runGrokResidue(projects, kinds)
    return isCodexKey(target.projectKey) ? runCodexResidue(kinds) : runClaudeResidue(projects, kinds)
  }
  if (isGrokKey(target.projectKey)) return runGrokDelete(projects, target)
  if (isCodexKey(target.projectKey)) return runCodexDelete(projects, target, kinds)
  const plan = await planDelete(projects, target)
  if (plan.blocked) return { ok: false, error: plan.blocked }
  const failed = await trashPaths(plan.items.filter((i) => kinds.includes(i.kind)).map((i) => i.path))
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
 * Opens a Windows Terminal tab in `cwd` running `command` in PowerShell, which stays open after Claude exits
 * so the tab does not vanish.
 */
async function launchInTerminal(cwd: string, command: string): Promise<ActionResult> {
  if (!existsSync(cwd)) return { ok: false, error: { code: 'directory-missing', path: cwd } }
  // wt.exe splits its whole command line at ';' into separate tabs; '\;' passes a literal semicolon.
  const wtArg = (s: string) => s.replace(/;/g, '\\;')
  const child = spawn('wt.exe', ['-d', wtArg(cwd), 'pwsh', '-NoExit', '-Command', command], {
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

/** `claude --resume` for a conversation not already open elsewhere. */
export async function openInTerminal(
  projects: ProjectSummary[],
  projectKey: string,
  id: string,
): Promise<ActionResult> {
  const hit = findSession(projects, projectKey, id)
  if (!hit || isCodexKey(projectKey)) return { ok: false, error: { code: 'session-missing' } }
  if (isGrokKey(projectKey)) {
    if (await grokSessionBusy(id)) return { ok: false, error: { code: 'grok-session-open' } }
    return launchInTerminal(hit.project.path, `grok --resume ${id}`)
  }
  const live = await liveSessionIds()
  if (hit.family.versions.some((v) => live.has(v.id))) return { ok: false, error: OPEN_ERROR }
  // Resume the primary file: it holds the most complete copy of the conversation.
  return launchInTerminal(hit.project.path, `claude --resume ${hit.family.id}`)
}

/** A new Claude Code conversation in the project directory. */
export async function openProjectInTerminal(projects: ProjectSummary[], projectKey: string): Promise<ActionResult> {
  const project = projects.find((p) => p.key === projectKey)
  if (!project || project.source === 'codex') return { ok: false, error: { code: 'project-missing' } }
  return launchInTerminal(project.path, project.source === 'grok' ? 'grok' : 'claude')
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
  if (!hit || isGrokKey(projectKey) || isCodexKey(projectKey)) return { ok: false, error: { code: 'session-missing' } }
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

// ---- Grok sessions ---------------------------------------------------------

/**
 * Whether a Grok process has the session open, from ~/.grok/active_sessions.json. Its row format is not
 * documented, so any row mentioning the id counts, unless the row names a pid that has exited: Grok cannot
 * prune rows of crashed processes on Windows.
 */
async function grokSessionBusy(id: string): Promise<boolean> {
  let data: unknown
  try {
    data = JSON.parse(await fs.readFile(join(GROK_HOME, 'active_sessions.json'), 'utf8'))
  } catch (e) {
    // No file: no session is open. A file Grok is rewriting can't be read: assume the session may be open.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  if (!data || typeof data !== 'object') return true
  const rows: [string, unknown][] = Array.isArray(data)
    ? data.map((v) => ['', v])
    : data && typeof data === 'object'
      ? Object.entries(data)
      : []
  return rows.some(([key, value]) => {
    if (!(key + JSON.stringify(value)).includes(id)) return false
    const pid = (value as { pid?: unknown } | null)?.pid
    return typeof pid !== 'number' || pidAlive(pid)
  })
}

function run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 120_000, env: withoutParentSession(process.env) }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code ? error.message : '')) })
    })
  })
}

const lastLine = (text: string): string => text.trim().split(/\r?\n/).pop() ?? ''

/** Sessions to delete, each with the child sessions of its subagents at any depth; recomputed for every run. */
async function grokTargets(projects: ProjectSummary[], target: DeleteTarget) {
  const out: { id: string; dir: string; children: { id: string; dir: string }[] }[] = []
  for (const v of targetVersions(projects, target)) {
    const dir = grokSessionDir(v)
    out.push({ id: v.id, dir, children: await grokDescendants(dir) })
  }
  return out
}

/** Grok sessions are deleted permanently with `grok sessions delete`; nothing of them goes to the Recycle Bin first. */
async function planGrokDelete(projects: ProjectSummary[], target: DeleteTarget): Promise<DeletePlan> {
  const items: DeleteItem[] = []
  const sessions = await grokTargets(projects, target)
  for (const s of sessions) {
    items.push({ path: s.dir, bytes: (await sizeOf(s.dir)) ?? 0, kind: 'sessions' })
    for (const c of s.children) items.push({ path: c.dir, bytes: (await sizeOf(c.dir)) ?? 0, kind: 'artifacts' })
  }
  for (const s of sessions.flatMap((s) => [s, ...s.children])) {
    if (await grokSessionBusy(s.id)) return { items, blocked: { code: 'grok-session-open' }, mode: 'grok' }
  }
  return { items, mode: 'grok' }
}

async function runGrokDelete(projects: ProjectSummary[], target: DeleteTarget): Promise<ActionResult> {
  const sessions = await grokTargets(projects, target)
  for (const s of sessions.flatMap((s) => [s, ...s.children])) {
    if (await grokSessionBusy(s.id)) return { ok: false, error: { code: 'grok-session-open' } }
  }
  const failures: string[] = []
  for (const session of sessions) {
    if (await grokSessionBusy(session.id)) return { ok: false, error: { code: 'grok-session-open' } }
    const r = await run(grokExecutable(), ['sessions', 'delete', session.id])
    if (r.code !== 0 || existsSync(session.dir)) {
      // The parent is still there: keep its subagents' sessions with it.
      failures.push(lastLine(r.stderr || r.stdout) || session.dir)
      continue
    }
    for (const c of session.children) {
      if (await grokSessionBusy(c.id)) return { ok: false, error: { code: 'grok-session-open' } }
      await run(grokExecutable(), ['sessions', 'delete', c.id])
      // The CLI skips the local folders of hidden subagent sessions; those go to the Recycle Bin instead.
      if (existsSync(c.dir)) {
        if (await grokSessionBusy(c.id)) return { ok: false, error: { code: 'grok-session-open' } }
        await shell.trashItem(c.dir).catch(() => failures.push(c.dir))
      }
    }
    for (const dir of new Set([session.dir, ...session.children.map((c) => c.dir)].map(dirname))) await fs.rmdir(dir).catch(() => undefined)
  }
  return failures.length ? { ok: false, error: { code: 'grok-failed', detail: failures.join('\n') } } : { ok: true }
}

// ---- Codex threads ---------------------------------------------------------

/**
 * Codex Desktop (the MSIX app's Codex.exe) keeps its state file in memory and writes it back, which would
 * restore entries removed while it runs. Its bundled CLI is also named codex.exe, so the path decides.
 * When the check itself fails, Desktop counts as running.
 */
function codexDesktopRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "Name='Codex.exe'" -ErrorAction Stop | ForEach-Object { if (!$_.ExecutablePath) { throw 'ExecutablePath unavailable' }; $_.ExecutablePath }`,
      ],
      { windowsHide: true, timeout: 30_000 },
      (error, stdout) => resolve(!!error || /\\WindowsApps\\OpenAI\.Codex_/i.test(String(stdout))),
    )
  })
}

interface RpcMessage {
  id?: number
  method?: string
  error?: { message?: string }
}

/**
 * Deletes threads through Codex's own app-server `thread/delete`: the rollout file and the thread's rows in
 * Codex's databases (index, history projection, logs), subagent threads included. Returns the failures.
 */
function codexDeleteThreads(ids: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(codexExecutable(), ['app-server'], {
      env: withoutParentSession(process.env),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const waiting = new Map<number, (m: RpcMessage) => void>()
    let dead: string | null = null
    const fail = (reason: string) => {
      dead ??= reason
      for (const done of waiting.values()) done({ error: { message: reason } })
      waiting.clear()
    }
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let m: RpcMessage
        try {
          m = JSON.parse(line) as RpcMessage
        } catch {
          continue
        }
        if (m.id === undefined) continue
        if (m.method) {
          // A request from the server (approval, input) has no one to answer it here.
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unavailable' } }) + '\n')
          continue
        }
        waiting.get(m.id)?.(m)
        waiting.delete(m.id)
      }
    })
    child.on('error', (e) => fail(e.message))
    child.stdin.on('error', (e) => fail(e.message))
    child.on('exit', () => fail('Codex app-server exited'))
    let seq = 0
    const call = (method: string, params: unknown) =>
      new Promise<RpcMessage>((done) => {
        if (dead) return done({ error: { message: dead } })
        const id = ++seq
        waiting.set(id, done)
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    const timer = setTimeout(() => {
      fail('timed out')
      child.kill()
    }, 120_000)
    void (async () => {
      const failures: string[] = []
      const init = await call('initialize', { clientInfo: { name: 'agent-history-manager', version: app.getVersion() } })
      if (init.error) failures.push(init.error.message || 'initialize failed')
      else {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
        for (const id of ids) {
          const r = await call('thread/delete', { threadId: id })
          if (r.error) failures.push(`${id}: ${r.error.message ?? 'failed'}`)
          if (dead) break
        }
      }
      clearTimeout(timer)
      child.stdin.end()
      resolve(failures)
    })()
  })
}

/** Images and working folders; a date folder of projectless workspaces emptied by this goes too. */
async function trashFolders(folders: { path: string; kind: DeleteKind }[]): Promise<string[]> {
  return [
    ...(await trashPaths(folders.filter((f) => f.kind !== 'output').map((f) => f.path))),
    ...(await trashPaths(folders.filter((f) => f.kind === 'output').map((f) => f.path), true)),
  ]
}

const backupRoot = () => join(app.getPath('userData'), 'codex-backups', new Date().toISOString().replace(/[:.]/g, '-'))

/**
 * Removes the threads from Codex Desktop's state file (and its .bak copy) and from the name and prompt indexes.
 * Each changed file is copied to a backup folder first and replaced atomically.
 */
async function forgetCodexThreads(ids: string[]): Promise<string[]> {
  const failures: string[] = []
  const dir = backupRoot()
  const replace = async (file: string, next: string) => {
    await fs.mkdir(dir, { recursive: true })
    await fs.copyFile(file, join(dir, basename(file)))
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, next)
    await fs.rename(temp, file)
  }
  for (const file of [CODEX_GLOBAL_STATE, CODEX_GLOBAL_STATE + '.bak']) {
    try {
      if (!existsSync(file)) continue
      const { value, removed } = forgetThreads(JSON.parse(await fs.readFile(file, 'utf8')), ids)
      if (removed) await replace(file, JSON.stringify(value))
    } catch {
      failures.push(file)
    }
  }
  for (const name of ['session_index.jsonl', 'history.jsonl']) {
    const file = join(CODEX_HOME, name)
    try {
      if (!existsSync(file)) continue
      const lines = (await fs.readFile(file, 'utf8')).split('\n')
      const deleting = new Set(ids)
      const kept = lines.filter((l) => {
        try {
          const row = JSON.parse(l) as { id?: string; session_id?: string }
          return !deleting.has(name === 'session_index.jsonl' ? row.id ?? '' : row.session_id ?? '')
        } catch {
          return true
        }
      })
      if (kept.length !== lines.length) await replace(file, kept.join('\n'))
    } catch {
      failures.push(file)
    }
  }
  return failures
}

/** Threads to delete with what goes with them; recomputed for every run, never taken from the renderer. */
async function planCodexDelete(
  projects: ProjectSummary[],
  target: DeleteTarget,
): Promise<{ plan: DeletePlan; top: string[]; all: string[]; files: DeleteItem[]; extra: string[] }> {
  const top = targetVersions(projects, target).map((v) => v.id)
  const threads = [...top.map(codexThread).filter((t): t is CodexThread => !!t), ...codexDescendants(top)]
  const all = threads.map((t) => t.id)
  const state = await readGlobalState(true)
  const items: DeleteItem[] = []
  // Listed even when the rollout file is gone: the thread's index rows still need thread/delete.
  for (const t of threads) items.push({ path: t.rolloutPath || t.id, bytes: (t.rolloutPath && (await sizeOf(t.rolloutPath))) || 0, kind: 'sessions' })
  // Further rollout files named after these threads (`<thread>_<other>`); whatever thread/delete leaves of them is
  // moved to the Recycle Bin afterwards.
  const own = new Set(threads.map((t) => t.rolloutPath.toLowerCase()))
  const ids = new Set(all)
  // Keep copies that refer to another thread unless that thread is also being deleted.
  const extra = (await codexRolloutFiles())
    .filter((f) => ids.has(f.id) && !own.has(f.path.toLowerCase()) && !(f.other && !ids.has(f.other) && codexThread(f.other)))
    .map((f) => f.path)
  for (const path of extra) items.push({ path, bytes: (await sizeOf(path)) ?? 0, kind: 'sessions' })
  if (forgetThreads(state, all).removed) items.push({ path: CODEX_GLOBAL_STATE, bytes: 0, kind: 'sessions' })
  const files: DeleteItem[] = []
  for (const id of all) {
    const images = join(CODEX_HOME, 'generated_images', id)
    const bytes = await sizeOf(images)
    if (bytes !== null) files.push({ path: images, bytes, kind: 'artifacts' })
  }
  // A projectless thread works in a folder Desktop created for it alone; never one another thread still uses.
  const workspaces = await projectlessWorkspaces(state)
  const deleting = new Set(all)
  for (const t of threads) {
    const dir = workspaces.contains(t.cwd)
    if (!dir || files.some((f) => f.path.toLowerCase() === dir.toLowerCase())) continue
    const occupants = codexThreadsIn(dir)
    if (occupants === null || occupants.some((id) => !deleting.has(id))) continue
    const bytes = await sizeOf(dir)
    if (bytes !== null) files.push({ path: dir, bytes, kind: 'output' })
  }
  items.push(...files)
  const blocked: ActionError | undefined = (await codexDesktopRunning()) ? { code: 'codex-running' } : undefined
  return { plan: { items, blocked, mode: 'codex' }, top, all, files, extra }
}

async function runCodexDelete(projects: ProjectSummary[], target: DeleteTarget, kinds: DeleteKind[]): Promise<ActionResult> {
  const { plan, top, all, files, extra } = await planCodexDelete(projects, target)
  if (plan.blocked) return { ok: false, error: plan.blocked }
  const failures: string[] = []
  if (kinds.includes('sessions') && top.length) {
    failures.push(...(await codexDeleteThreads(top)))
    // Desktop's entries and the threads' files go only once Codex has deleted the threads themselves.
    if (failures.length) return { ok: false, error: { code: 'codex-failed', detail: failures.join('\n') } }
    if (await codexDesktopRunning()) return { ok: false, error: { code: 'codex-running' } }
    failures.push(...(await forgetCodexThreads(all)))
    for (const path of extra.filter((x) => existsSync(x))) await shell.trashItem(path).catch(() => failures.push(path))
  }
  failures.push(...(await trashFolders(files.filter((f) => kinds.includes(f.kind)))))
  return failures.length ? { ok: false, error: { code: 'codex-failed', detail: failures.join('\n') } } : { ok: true }
}

/**
 * Leftovers of threads that are no longer listed: rollout files Codex has no index row for (deleted through
 * thread/delete, which also removes their history and log rows), Desktop state entries of deleted threads, and
 * their output folders and generated images (to the Recycle Bin). Each kind can be kept.
 */
async function planCodexResidue() {
  const residue = await scanCodexResidue()
  // A thread being created may be written before Codex indexes it.
  const fresh = async <T extends { path: string }>(xs: T[]) => {
    const out: T[] = []
    for (const x of xs) if (!(await recentlyUsed(x.path))) out.push(x)
    return out
  }
  const recentIds = new Set<string>()
  for (const r of residue.rollouts) if (await recentlyUsed(r.path)) recentIds.add(r.id)
  residue.rollouts = residue.rollouts.filter((r) => !recentIds.has(r.id))
  residue.folders = await fresh(residue.folders)
  const items: DeleteItem[] = []
  for (const r of residue.rollouts) items.push({ path: r.path, bytes: (await sizeOf(r.path)) ?? 0, kind: 'sessions' })
  if (residue.stateIds.length) items.push({ path: CODEX_GLOBAL_STATE, bytes: 0, kind: 'cache' })
  for (const f of residue.folders) items.push({ path: f.path, bytes: (await sizeOf(f.path)) ?? 0, kind: f.kind })
  const blocked: ActionError | undefined = (await codexDesktopRunning()) ? { code: 'codex-running' } : undefined
  return { plan: { items, blocked, mode: 'codex' } as DeletePlan, residue }
}

async function runCodexResidue(kinds: DeleteKind[]): Promise<ActionResult> {
  const { plan, residue } = await planCodexResidue()
  if (plan.blocked) return { ok: false, error: plan.blocked }
  const failures: string[] = []
  const forget = kinds.includes('cache') ? [...residue.stateIds] : []
  if (kinds.includes('sessions') && residue.rollouts.length) {
    const failed = await codexDeleteThreads([...new Set(residue.rollouts.map((r) => r.id))])
    failures.push(...failed)
    if (failures.length) return { ok: false, error: { code: 'codex-failed', detail: failures.join('\n') } }
    if (await codexDesktopRunning()) return { ok: false, error: { code: 'codex-running' } }
    failures.push(...(await trashPaths(residue.rollouts.map((r) => r.path).filter((p) => existsSync(p)))))
    // A deleted rollout's thread may still be named in Desktop's state.
    if (kinds.includes('cache')) forget.push(...residue.rollouts.map((r) => r.id))
  }
  if (forget.length) failures.push(...(await forgetCodexThreads(forget)))
  failures.push(...(await trashFolders(residue.folders.filter((x) => kinds.includes(x.kind)))))
  return failures.length ? { ok: false, error: { code: 'codex-failed', detail: failures.join('\n') } } : { ok: true }
}

/**
 * Grok session folders the list does not show (see scanGrokResidue). They hold no listed conversation, so they go
 * to the Recycle Bin instead of `grok sessions delete`; sessions open in Grok are left out.
 */
async function planGrokResidue(projects: ProjectSummary[]) {
  const listed = new Set(projects.filter((p) => p.source === 'grok').flatMap((p) => p.sessions.map((s) => s.id)))
  const folders: { id: string; path: string; kind: 'sessions' | 'artifacts' }[] = []
  const seen = new Set<string>()
  for (const f of await scanGrokResidue(listed)) {
    const related = [f, ...(await grokDescendants(f.path)).map((c) => ({ id: c.id, path: c.dir, kind: 'artifacts' as const }))]
    let protectedSession = false
    for (const c of related) {
      if (await grokSessionBusy(c.id) || await recentlyUsed(c.path)) {
        protectedSession = true
        break
      }
    }
    if (protectedSession) continue
    for (const c of related) {
      if (seen.has(c.path.toLowerCase())) continue
      seen.add(c.path.toLowerCase())
      folders.push(c)
    }
  }
  const items: DeleteItem[] = []
  for (const f of folders) items.push({ path: f.path, bytes: (await sizeOf(f.path)) ?? 0, kind: f.kind })
  return { plan: { items } as DeletePlan, folders }
}

async function runGrokResidue(projects: ProjectSummary[], kinds: DeleteKind[]): Promise<ActionResult> {
  const { folders } = await planGrokResidue(projects)
  for (const f of folders) if (await grokSessionBusy(f.id)) return { ok: false, error: { code: 'grok-session-open' } }
  // The working-folder level under ~/.grok/sessions goes too once its last session is gone.
  const failures = await trashPaths(folders.filter((x) => kinds.includes(x.kind)).map((f) => f.path), true)
  return failures.length ? { ok: false, error: { code: 'trash-failed', files: failures } } : { ok: true }
}

// ---- Claude Code leftovers ---------------------------------------------------

const RECENT_MS = 24 * 3_600_000

async function hasConversation(file: string): Promise<boolean> {
  try {
    let found = false
    const offset = await readLines(file, 0, (line) => {
      if (found) return
      try {
        const r = JSON.parse(line.toString('utf8')) as RawRecord
        found = r.type === 'assistant' || (r.type === 'user' && classifyUser(r)?.kind === 'prompt')
      } catch {
        found = true
      }
    })
    return found || offset < (await fs.stat(file)).size
  } catch {
    return true
  }
}

/** Whether the path, or anything up to two levels inside it, changed within RECENT_MS. */
async function recentlyUsed(path: string, depth = 2): Promise<boolean> {
  try {
    const st = await fs.lstat(path)
    if (Date.now() - st.mtimeMs < RECENT_MS) return true
    if (!st.isDirectory() || depth === 0) return false
    for (const e of await fs.readdir(path)) if (await recentlyUsed(join(path, e), depth - 1)) return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  return false
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function dirNames(path: string): Promise<string[]> {
  try {
    return (await fs.readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return []
  }
}

/**
 * Files the list does not account for: session files without a prompt (with everything versionPaths names for
 * them), and per-session folders whose session file is gone: subagent and tool output, /rewind backups,
 * session-env, temporary workspaces. Project folders without any session are listed too; their memory starts
 * unchecked. Sessions open in Claude Code are skipped.
 */
async function planClaudeResidue(projects: ProjectSummary[]) {
  const listed = new Set(projects.filter((p) => p.source === 'claude').flatMap((p) => p.sessions.flatMap((s) => s.versions.map((v) => v.id))))
  const live = await liveSessionIds()
  const known = new Set<string>()
  const copies = new Map<string, number>()
  const empty: SessionVersion[] = []
  const memoryDirs = new Set(projects.filter((p) => p.source === 'claude').map((p) => projectMemoryDir(p.path).toLowerCase()))
  /** Project folders with a session open in Claude Code */
  const liveDirs = new Set<string>()
  const paths: { path: string; kind: DeleteKind }[] = []
  const folders: { dir: string; names: string[]; ids: string[] }[] = []
  for (const dir of await dirNames(PROJECTS_DIR)) {
    const names = await fs.readdir(join(PROJECTS_DIR, dir))
    const ids = names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6))
    folders.push({ dir, names, ids })
    for (const id of ids) {
      known.add(id)
      copies.set(id, (copies.get(id) ?? 0) + 1)
    }
    if ([...ids, ...names].some((id) => live.has(id))) liveDirs.add(dir.toLowerCase())
  }
  const orphan = (id: string) => SESSION_ID.test(id) && !known.has(id) && !live.has(id)
  for (const { dir, names, ids } of folders) {
    if (!ids.length) {
      // A project without sessions: only its memory has value, so that starts unchecked.
      if (liveDirs.has(dir.toLowerCase())) continue
      for (const n of names) {
        if (SESSION_ID.test(n) && !orphan(n)) continue
        const path = join(PROJECTS_DIR, dir, n)
        if (n.toLowerCase() === 'memory' && memoryDirs.has(path.toLowerCase())) continue
        paths.push({ path, kind: n.toLowerCase() === 'memory' ? 'memory' : 'artifacts' })
      }
      continue
    }
    for (const id of ids) {
      // Unlisted because no prompt was typed; one Claude answered (a slash command or skill run) is a conversation.
      const file = join(PROJECTS_DIR, dir, id + '.jsonl')
      if (!listed.has(id) && !live.has(id) && !(await recentlyUsed(file)) && !(await hasConversation(file))) {
        empty.push({ id, dir, title: '', lastActivity: 0, promptCount: 0 })
      }
    }
    for (const n of names) {
      if (orphan(n)) paths.push({ path: join(PROJECTS_DIR, dir, n), kind: 'artifacts' })
    }
  }
  const emptyCopies = new Map<string, number>()
  for (const v of empty) emptyCopies.set(v.id, (emptyCopies.get(v.id) ?? 0) + 1)
  for (const v of empty) {
    // Rewind backups and sidecars can still be used by a nonempty copy in another project folder.
    paths.push(...versionPaths(v).filter((p) => p.kind === 'sessions' || emptyCopies.get(v.id) === copies.get(v.id)))
  }
  for (const id of (await dirNames(join(CLAUDE_DIR, 'file-history'))).filter(orphan)) paths.push({ path: join(CLAUDE_DIR, 'file-history', id), kind: 'history' })
  for (const id of (await dirNames(join(CLAUDE_DIR, 'session-env'))).filter(orphan)) paths.push({ path: join(CLAUDE_DIR, 'session-env', id), kind: 'artifacts' })
  const temp = join(tmpdir(), 'claude')
  for (const dir of await dirNames(temp)) {
    // A running Claude Code keeps its own temporary folder under an id that is not its transcript's after a
    // resume, so nothing in the project folder of an open session counts as left over.
    if (liveDirs.has(dir.toLowerCase())) continue
    for (const id of (await dirNames(join(temp, dir))).filter(orphan)) paths.push({ path: join(temp, dir, id), kind: 'temp' })
  }
  const seen = new Set<string>()
  const unique: typeof paths = []
  for (const p of paths) {
    if (seen.has(p.path.toLowerCase())) continue
    seen.add(p.path.toLowerCase())
    // Anything touched in the last day may belong to a session that is starting or still running.
    if (!(await recentlyUsed(p.path))) unique.push(p)
  }
  const items = await existing(unique)
  return { plan: { items, unchecked: ['memory'] } as DeletePlan, items }
}

async function runClaudeResidue(projects: ProjectSummary[], kinds: DeleteKind[]): Promise<ActionResult> {
  const { items } = await planClaudeResidue(projects)
  // A project or temp-workspace folder emptied by this goes too.
  const failed = await trashPaths(items.filter((i) => kinds.includes(i.kind)).map((i) => i.path), true)
  return failed.length ? { ok: false, error: { code: 'trash-failed', files: failed } } : { ok: true }
}
