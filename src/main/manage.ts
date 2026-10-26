import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
  readGlobalState,
  type CodexThread,
} from './codex'
import { findGrokSessionDir, GROK_HOME, grokExecutable, grokSessionDir, isGrokKey, readGrokAgents } from './grok'
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
  if (isGrokKey(target.projectKey)) return planGrokDelete(projects, target)
  if (isCodexKey(target.projectKey)) return (await planCodexDelete(projects, target)).plan
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
  if (isGrokKey(target.projectKey)) return runGrokDelete(projects, target)
  if (isCodexKey(target.projectKey)) return runCodexDelete(projects, target, kinds)
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
  } catch {
    return false
  }
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

/** Sessions to delete, each with the child sessions of its subagents; recomputed for every run. */
async function grokTargets(projects: ProjectSummary[], target: DeleteTarget) {
  const out: { id: string; dir: string; children: { id: string; dir: string }[] }[] = []
  for (const v of targetVersions(projects, target)) {
    const dir = grokSessionDir(v)
    const children: { id: string; dir: string }[] = []
    for (const id of (await readGrokAgents(dir)).keys()) {
      const childDir = await findGrokSessionDir(id)
      if (childDir) children.push({ id, dir: childDir })
    }
    out.push({ id: v.id, dir, children })
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
  for (const s of sessions) {
    if (await grokSessionBusy(s.id)) return { items, blocked: { code: 'grok-session-open' }, mode: 'grok' }
  }
  return { items, mode: 'grok' }
}

async function runGrokDelete(projects: ProjectSummary[], target: DeleteTarget): Promise<ActionResult> {
  const sessions = await grokTargets(projects, target)
  for (const s of sessions) {
    if (await grokSessionBusy(s.id)) return { ok: false, error: { code: 'grok-session-open' } }
  }
  const failures: string[] = []
  for (const session of sessions) {
    for (const s of [session, ...session.children]) {
      const r = await run(grokExecutable(), ['sessions', 'delete', s.id])
      if (!existsSync(s.dir)) continue
      // The CLI skips the local folders of hidden subagent sessions; those go to the Recycle Bin instead.
      if (s === session) failures.push(lastLine(r.stderr || r.stdout) || s.dir)
      else await shell.trashItem(s.dir).catch(() => failures.push(s.dir))
    }
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
        `Get-CimInstance Win32_Process -Filter "Name='Codex.exe'" | ForEach-Object { "$($_.ExecutablePath) $($_.CommandLine)" }`,
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
    const fail = (reason: string) => {
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
    child.on('exit', () => fail('Codex app-server exited'))
    let seq = 0
    const call = (method: string, params: unknown) =>
      new Promise<RpcMessage>((done) => {
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
        }
      }
      clearTimeout(timer)
      child.stdin.end()
      resolve(failures)
    })()
  })
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
      const kept = lines.filter((l) => !ids.some((id) => l.includes(id)))
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
): Promise<{ plan: DeletePlan; top: string[]; all: string[]; files: DeleteItem[] }> {
  const top = targetVersions(projects, target).map((v) => v.id)
  const threads = [...top.map(codexThread).filter((t): t is CodexThread => !!t), ...codexDescendants(top)]
  const all = threads.map((t) => t.id)
  const state = await readGlobalState()
  const items: DeleteItem[] = []
  for (const t of threads) {
    if (t.rolloutPath) {
      const bytes = await sizeOf(t.rolloutPath)
      if (bytes !== null) items.push({ path: t.rolloutPath, bytes, kind: 'sessions' })
    }
  }
  if (forgetThreads(state, all).removed) items.push({ path: CODEX_GLOBAL_STATE, bytes: 0, kind: 'sessions' })
  const files: DeleteItem[] = []
  for (const id of all) {
    const images = join(CODEX_HOME, 'generated_images', id)
    const bytes = await sizeOf(images)
    if (bytes !== null) files.push({ path: images, bytes, kind: 'artifacts' })
  }
  // A projectless thread works in a folder Desktop created for it alone; never one another thread still uses.
  const outputs = state['thread-projectless-output-directories'] ?? {}
  const remaining = projects.flatMap((p) => (p.source === 'codex' ? p.sessions : [])).filter((s) => !top.includes(s.id))
  for (const id of top) {
    const dir = outputs[id]
    if (!dir || !(state['projectless-thread-ids'] ?? []).includes(id)) continue
    const shared = remaining.some((s) => outputs[s.id] && outputs[s.id].toLowerCase() === dir.toLowerCase())
    const bytes = shared ? null : await sizeOf(dir)
    if (bytes !== null) files.push({ path: dir, bytes, kind: 'output' })
  }
  items.push(...files)
  const blocked: ActionError | undefined = (await codexDesktopRunning()) ? { code: 'codex-running' } : undefined
  return { plan: { items, blocked, mode: 'codex' }, top, all, files }
}

async function runCodexDelete(projects: ProjectSummary[], target: DeleteTarget, kinds: DeleteKind[]): Promise<ActionResult> {
  const { plan, top, all, files } = await planCodexDelete(projects, target)
  if (plan.blocked) return { ok: false, error: plan.blocked }
  const failures: string[] = []
  if (kinds.includes('sessions') && top.length) {
    failures.push(...(await codexDeleteThreads(top)))
    // Desktop's entries go only once Codex has deleted the threads themselves.
    if (!failures.length) failures.push(...(await forgetCodexThreads(all)))
  }
  for (const { path } of files.filter((f) => kinds.includes(f.kind))) {
    await shell.trashItem(path).catch(() => failures.push(path))
  }
  return failures.length ? { ok: false, error: { code: 'codex-failed', detail: failures.join('\n') } } : { ok: true }
}
