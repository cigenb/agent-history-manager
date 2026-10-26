import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'history-delete-'))
process.env.CODEX_HOME = join(home, '.codex')
process.env.GROK_HOME = join(home, '.grok')
const trashed = []
const cliCalls = []
let rpcFailure = null
let rpcFailureAt = 'initialize'
let grokFailure = null
let stdinFailure = false
let failTrash = null
let afterGrokDelete = null
let desktopRunning = false
let startDesktopOnDelete = false
const assertInside = (path) => {
  const rel = relative(home, resolve(path))
  assert.ok(rel && !rel.startsWith('..') && !resolve(path).includes('\\..\\'), path)
}

globalThis.deleteTest = {
  home,
  app: { getVersion: () => 'test', getPath: () => join(home, 'appdata') },
  shell: {
    async trashItem(path) {
      assertInside(path)
      if (path === failTrash) throw new Error('locked')
      trashed.push(path)
      await rm(path, { recursive: true, force: true })
    },
  },
  execFile(file, args, _options, cb) {
    if (file === 'powershell.exe') return cb(null, desktopRunning ? 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\Codex.exe' : '', '')
    const id = args.at(-1)
    cliCalls.push(id)
    if (id === grokFailure) return cb({ code: 1 }, '', 'delete failed')
    void (async () => {
      for (const cwd of await (await import('node:fs/promises')).readdir(join(home, '.grok', 'sessions'))) {
        const path = join(home, '.grok', 'sessions', cwd, id)
        assertInside(path)
        await rm(path, { recursive: true, force: true })
      }
      await afterGrokDelete?.(id)
      cb(null, '', '')
    })()
  },
  spawn() {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        const m = JSON.parse(String(chunk))
        if (stdinFailure) return done(new Error('broken pipe'))
        if (!m.id) return done()
        if (m.method === 'thread/delete') {
          cliCalls.push(m.params.threadId)
          if (startDesktopOnDelete) desktopRunning = true
        }
        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ id: m.id, ...(rpcFailure && m.method === rpcFailureAt ? { error: { message: rpcFailure } } : { result: {} }) }) + '\n')
        })
        done()
      },
    })
    child.kill = () => child.emit('exit', 1)
    return child
  },
}

const stub = (name) => `delete-test:${name}`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'node:child_process' || specifier === 'node:os') return { url: stub(specifier), shortCircuit: true }
    try { return next(specifier, context) } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw e
      return next(specifier + '.ts', context)
    }
  },
  load(url, context, next) {
    if (url === stub('electron')) return { format: 'module', shortCircuit: true, source: 'export const { app, shell } = globalThis.deleteTest' }
    if (url === stub('node:child_process')) return { format: 'module', shortCircuit: true, source: 'export const { execFile, spawn } = globalThis.deleteTest' }
    if (url === stub('node:os')) return { format: 'module', shortCircuit: true, source: 'export const homedir = () => globalThis.deleteTest.home; export const tmpdir = homedir' }
    return next(url, context)
  },
})

const { planDelete, runDelete } = await import('../src/main/manage.ts')
const { loadSession, projectMemoryDir, PROJECTS_DIR, SessionIndex } = await import('../src/main/sessions.ts')
const { SearchIndex } = await import('../src/main/search.ts')
const { findGrokSessionDir, GrokIndex, loadGrokSession, scanGrokResidue } = await import('../src/main/grok.ts')
const { CODEX_GLOBAL_STATE, codexThreadsIn, loadCodexSession, scanCodex, scanCodexResidue } = await import('../src/main/codex.ts')
const id = (n) => `01a00000-0000-7000-8000-${String(n).padStart(12, '0')}`
const version = (id, dir) => ({ id, dir, title: id, lastActivity: 0, promptCount: 1 })
function project(source, path, versions) {
  const key = `${source === 'claude' ? '' : source + ':'}${path.toLowerCase()}`
  return { source, key, path, name: 'Fixture', sessions: versions.map((v) => ({ ...v, projectKey: key, versions: [v] })) }
}
async function put(path, content = 'fixture') {
  assertInside(path)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
async function age(path) {
  const { readdir } = await import('node:fs/promises')
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name)
    if (e.isDirectory()) await age(p)
    else await utimes(p, 1, 1)
  }
  await utimes(path, 1, 1)
}
async function grokSession(sid, kind, messages = [], dir = 'cwd') {
  const path = join(home, '.grok', 'sessions', dir, sid)
  await put(join(path, 'summary.json'), JSON.stringify({ session_kind: kind }))
  await put(join(path, 'updates.jsonl'), messages.map((sessionUpdate) => JSON.stringify({ params: { update: { sessionUpdate } } })).join('\n') + '\n')
  return path
}
let db
test.beforeEach(async () => {
  for (const name of ['.claude', '.grok', '.codex', 'claude', 'workspaces', 'appdata']) {
    const path = join(home, name)
    assertInside(path)
    await rm(path, { recursive: true, force: true })
    await mkdir(path, { recursive: true })
  }
  trashed.length = cliCalls.length = 0
  rpcFailure = grokFailure = failTrash = null
  afterGrokDelete = null
  desktopRunning = startDesktopOnDelete = false
  rpcFailureAt = 'initialize'
  stdinFailure = false
  db = new DatabaseSync(join(home, '.codex', 'state_5.sqlite'))
  db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT,
    title TEXT, first_user_message TEXT, archived INTEGER);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`)
})
test.afterEach(() => db.close())
test.after(() => rm(home, { recursive: true, force: true }))

test('Grok residue routes to the scanner and Recycle Bin, with selectable kinds', async () => {
  const path = await grokSession(id(1), null)
  await age(join(home, '.grok'))
  const target = { kind: 'residue', projectKey: 'grok:residue' }
  const plan = await planDelete([], target)
  assert.deepEqual(plan.items.map((x) => [x.path, x.kind]), [[path, 'sessions']])
  assert.equal(plan.mode, undefined)
  await runDelete([], target, ['artifacts'])
  assert.deepEqual(trashed, [])
  await runDelete([], target, ['sessions'])
  assert.deepEqual(trashed, [path])
  assert.deepEqual(cliCalls, [])
})

test('Grok preserves unlisted user prompts, spaced JSON answers and unreadable logs', async () => {
  await grokSession(id(1), null, ['user_message_chunk'])
  const answer = await grokSession(id(2), null)
  await put(join(answer, 'updates.jsonl'), '{"params": {"update": {"sessionUpdate": "agent_message_chunk"}}}\n')
  const unreadable = await grokSession(id(3), null)
  await rm(join(unreadable, 'updates.jsonl'))
  await mkdir(join(unreadable, 'updates.jsonl'))
  assert.deepEqual(await scanGrokResidue(new Set()), [])
})

test('Grok child references use metadata ids and never delete an unrelated top-level session', async () => {
  const parent = await grokSession(id(1), null, ['user_message_chunk'])
  const child = await grokSession(id(2), 'subagent', ['agent_message_chunk'])
  const unrelated = await grokSession(id(3), null, ['user_message_chunk'])
  await put(join(parent, 'subagents', 'agent-label', 'meta.json'), JSON.stringify({ child_session_id: id(2) }))
  await put(join(parent, 'subagents', id(3), 'meta.json'), JSON.stringify({ child_session_id: id(3) }))
  assert.ok(!(await scanGrokResidue(new Set([id(1), id(3)]))).some((f) => f.path === child))
  const p = project('grok', 'cwd', [version(id(1), 'cwd')])
  const target = { kind: 'session', projectKey: p.key, id: id(1) }
  await runDelete([p], target, ['sessions', 'artifacts'])
  assert.ok(existsSync(unrelated))
  assert.ok(!existsSync(child))
})

test('Grok refuses a project deletion when a descendant is active', async () => {
  const parent = await grokSession(id(1), null, ['user_message_chunk'])
  await grokSession(id(2), 'subagent', ['agent_message_chunk'], 'elsewhere')
  await put(join(parent, 'subagents', id(2), 'meta.json'), '{}')
  await put(join(home, '.grok', 'active_sessions.json'), JSON.stringify([{ session_id: id(2), pid: process.pid }]))
  const p = project('grok', 'cwd', [version(id(1), 'cwd')])
  const target = { kind: 'project', projectKey: p.key }
  assert.equal((await planDelete([p], target)).blocked?.code, 'grok-session-open')
  assert.equal((await runDelete([p], target, ['sessions'])).error?.code, 'grok-session-open')
  assert.deepEqual(cliCalls, [])
})

test('Grok keeps descendants when the parent CLI deletion fails', async () => {
  const parent = await grokSession(id(1), null, ['user_message_chunk'])
  const child = await grokSession(id(2), 'subagent')
  await put(join(parent, 'subagents', id(2), 'meta.json'), '{}')
  grokFailure = id(1)
  const p = project('grok', 'cwd', [version(id(1), 'cwd')])
  assert.equal((await runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions'])).ok, false)
  assert.ok(existsSync(child))
  assert.deepEqual(cliCalls, [id(1)])
})

test('Claude residue protects globally known ids, live artifacts and stale-index prompts', async () => {
  await put(join(PROJECTS_DIR, 'a', id(1) + '.jsonl'), '{"type": "assistant"}\n')
  await put(join(PROJECTS_DIR, 'b', id(1), 'tool.txt'))
  await put(join(PROJECTS_DIR, 'c', id(2) + '.jsonl'), '{"type":"user","origin":{"kind":"human"},"message":{"content":"Unsaved index"}}\n')
  await put(join(PROJECTS_DIR, 'd', id(3), 'tool.txt'))
  await put(join(home, '.claude', 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id(3) }))
  await age(PROJECTS_DIR)
  const plan = await planDelete([], { kind: 'residue', projectKey: 'residue' })
  assert.deepEqual(plan.items, [])
})

test('Claude deletion selects categories, keeps other project memory and reports locked paths', async () => {
  const p = project('claude', 'C:\\example\\one', [version(id(1), 'copied-folder')])
  const memory = projectMemoryDir(p.path)
  const otherMemory = join(PROJECTS_DIR, 'copied-folder', 'memory', 'MEMORY.md')
  await put(join(memory, 'MEMORY.md'))
  await put(otherMemory)
  const transcript = join(PROJECTS_DIR, 'copied-folder', id(1) + '.jsonl')
  await put(transcript)
  await put(join(PROJECTS_DIR, 'copied-folder', id(1), 'tool.txt'))
  failTrash = transcript
  const r = await runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions', 'memory'])
  assert.equal(r.ok, false)
  assert.deepEqual(r.error.files, [transcript])
  assert.ok(existsSync(otherMemory))
  assert.ok(existsSync(join(PROJECTS_DIR, 'copied-folder', id(1), 'tool.txt')))
  assert.ok(!existsSync(memory))
})

test('Claude preserves memory shared by colliding project folder names', async () => {
  const a = project('claude', 'C:\\example\\a-b', [version(id(1), 'a')])
  const b = project('claude', 'C:\\example\\a_b', [version(id(2), 'b')])
  assert.equal(projectMemoryDir(a.path), projectMemoryDir(b.path))
  await put(join(projectMemoryDir(a.path), 'MEMORY.md'))
  const plan = await planDelete([a, b], { kind: 'project', projectKey: a.key })
  assert.ok(!plan.items.some((x) => x.kind === 'memory'))
})

test('Claude refuses deletion while a live status file cannot be parsed', async () => {
  const p = project('claude', 'C:\\example', [version(id(1), 'a')])
  await put(join(PROJECTS_DIR, 'a', id(1) + '.jsonl'))
  await put(join(home, '.claude', 'sessions', process.pid + '.json'), '{')
  await assert.rejects(() => runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions']))
  assert.deepEqual(trashed, [])
})

async function codexResidueFixture() {
  const rollout = join(home, '.codex', 'sessions', `rollout-2026-01-01-${id(1)}.jsonl`)
  await put(rollout)
  await put(join(home, '.codex', 'generated_images', id(1), 'a.png'))
  await put(CODEX_GLOBAL_STATE, JSON.stringify({ 'projectless-thread-ids': [id(1)] }))
  await age(join(home, '.codex'))
  return rollout
}

test('Codex initialization failure preserves residue caches, images and outputs', async () => {
  await codexResidueFixture()
  const before = await readFile(CODEX_GLOBAL_STATE, 'utf8')
  rpcFailure = 'initialize failed'
  const r = await runDelete([], { kind: 'residue', projectKey: 'codex:residue' }, ['sessions', 'cache', 'artifacts', 'output'])
  assert.equal(r.ok, false)
  assert.equal(await readFile(CODEX_GLOBAL_STATE, 'utf8'), before)
  assert.deepEqual(trashed, [])
})

test('Codex residue deletes each id once and recycles any remaining rollout copies', async () => {
  const first = await codexResidueFixture()
  const second = first.replace('.jsonl', `_${id(2)}.jsonl`)
  await put(second)
  await age(join(home, '.codex'))
  const r = await runDelete([], { kind: 'residue', projectKey: 'codex:residue' }, ['sessions'])
  assert.equal(r.ok, true)
  assert.deepEqual(cliCalls, [id(1)])
  assert.deepEqual(new Set(trashed), new Set([first, second]))
})

test('Codex residue protects rollouts whose second id is still indexed', async () => {
  const rollout = await codexResidueFixture()
  await put(rollout.replace('.jsonl', `_${id(2)}.jsonl`))
  db.prepare('INSERT INTO threads VALUES (?, ?, 1, 1, ?, ?, ?, NULL, 0)').run(id(2), 'other', 'vscode', home, 'Keep')
  assert.deepEqual((await scanCodexResidue()).rollouts, [])
})

test('Codex cache cleanup keeps another thread whose title or prompt mentions a deleted id', async () => {
  await codexResidueFixture()
  const index = join(home, '.codex', 'session_index.jsonl')
  const history = join(home, '.codex', 'history.jsonl')
  const keepIndex = JSON.stringify({ id: id(2), thread_name: `Discuss ${id(1)}` })
  const keepPrompt = JSON.stringify({ session_id: id(2), text: `Inspect ${id(1)}` })
  await put(index, JSON.stringify({ id: id(1), thread_name: 'Delete' }) + '\n' + keepIndex + '\n')
  await put(history, JSON.stringify({ session_id: id(1), text: 'Delete' }) + '\n' + keepPrompt + '\n')
  assert.equal((await runDelete([], { kind: 'residue', projectKey: 'codex:residue' }, ['cache'])).ok, true)
  assert.equal(await readFile(index, 'utf8'), keepIndex + '\n')
  assert.equal(await readFile(history, 'utf8'), keepPrompt + '\n')
})

test('Codex workspace cleanup preserves configured projects even without threads', async () => {
  const ws = join(home, 'workspaces', '2026-01-01', 'keep')
  await put(join(ws, 'outputs', 'a.txt'))
  await put(CODEX_GLOBAL_STATE, JSON.stringify({
    'thread-projectless-output-directories': { [id(1)]: join(ws, 'outputs') },
    'local-projects': { project: { id: 'project', rootPaths: [ws] } },
  }))
  assert.deepEqual((await scanCodexResidue()).folders, [])
})

test('Claude session deletion covers every version and category, leaving project memory intact', async () => {
  const v1 = version(id(1), 'a')
  const v2 = version(id(2), 'b')
  const p = project('claude', 'C:\\example', [v1])
  p.sessions[0].versions.push(v2)
  const expected = []
  for (const v of [v1, v2]) {
    for (const file of [
      join(PROJECTS_DIR, v.dir, v.id + '.jsonl'),
      join(PROJECTS_DIR, v.dir, v.id, 'tool.txt'),
      join(home, '.claude', 'file-history', v.id, 'backup'),
      join(home, '.claude', 'session-env', v.id, 'env'),
      join(home, 'claude', v.dir, v.id, 'scratch'),
    ]) {
      await put(file)
      expected.push(file.endsWith('.jsonl') ? file : dirname(file))
    }
  }
  const memory = join(projectMemoryDir(p.path), 'MEMORY.md')
  await put(memory)
  const r = await runDelete([p], { kind: 'session', projectKey: p.key, id: id(2) }, ['sessions', 'artifacts', 'history', 'temp', 'memory'])
  assert.equal(r.ok, true)
  assert.deepEqual(new Set(trashed), new Set(expected))
  assert.ok(existsSync(memory))
})

test('Claude project deletion refuses a running alternate version', async () => {
  const p = project('claude', 'C:\\example', [version(id(1), 'a')])
  p.sessions[0].versions.push(version(id(2), 'b'))
  await put(join(home, '.claude', 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id(2) }))
  assert.equal((await runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions'])).error.code, 'session-open')
  assert.deepEqual(trashed, [])
})

test('Claude residue keeps recent files, active project scratch ids, incomplete logs and memory by default', async () => {
  const p = project('claude', 'C:\\example', [version(id(1), 'a')])
  await put(join(PROJECTS_DIR, 'a', id(1) + '.jsonl'))
  await put(join(home, '.claude', 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id(1) }))
  await put(join(home, 'claude', 'a', id(2), 'scratch'))
  await age(join(home, 'claude'))
  await put(join(PROJECTS_DIR, 'recent', id(3) + '.jsonl'), '{}\n')
  await put(join(PROJECTS_DIR, 'incomplete', id(4) + '.jsonl'), '{"type":"user"')
  await age(join(PROJECTS_DIR, 'incomplete'))
  const memory = join(PROJECTS_DIR, 'orphan', 'memory')
  await put(join(memory, 'MEMORY.md'))
  await age(join(PROJECTS_DIR, 'orphan'))
  const plan = await planDelete([p], { kind: 'residue', projectKey: 'residue' })
  assert.deepEqual(plan.items.map((x) => [x.path, x.kind]), [[memory, 'memory']])
  assert.deepEqual(plan.unchecked, ['memory'])
})

test('Grok deletes multilevel children across working folders and handles cyclic metadata', async () => {
  const parent = await grokSession(id(1), null, ['user_message_chunk'])
  const child = await grokSession(id(2), 'subagent', [], 'child-cwd')
  await grokSession(id(3), 'subagent_fork', [], 'grandchild-cwd')
  await put(join(parent, 'subagents', id(2), 'meta.json'), '{}')
  await put(join(child, 'subagents', id(3), 'meta.json'), '{}')
  await put(join(child, 'subagents', id(1), 'meta.json'), '{}')
  const p = project('grok', 'cwd', [version(id(1), 'cwd')])
  assert.equal((await runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions'])).ok, true)
  assert.deepEqual(cliCalls, [id(1), id(2), id(3)])
  assert.ok(!existsSync(dirname(child)))
})

test('Grok unreadable active-session state blocks regular and residue deletion', async () => {
  await grokSession(id(1), null)
  await age(join(home, '.grok'))
  await put(join(home, '.grok', 'active_sessions.json'), '{')
  const p = project('grok', 'cwd', [version(id(1), 'cwd')])
  assert.equal((await runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions'])).error.code, 'grok-session-open')
  assert.deepEqual((await planDelete([], { kind: 'residue', projectKey: 'grok:residue' })).items, [])
  assert.deepEqual(cliCalls, [])
  assert.deepEqual(trashed, [])
})

test('Codex thread/delete and stdin failures stop cleanup immediately', async () => {
  await codexResidueFixture()
  rpcFailure = 'delete failed'
  rpcFailureAt = 'thread/delete'
  assert.equal((await runDelete([], { kind: 'residue', projectKey: 'codex:residue' }, ['sessions', 'cache', 'artifacts'])).ok, false)
  assert.deepEqual(trashed, [])
  stdinFailure = true
  const started = Date.now()
  assert.equal((await runDelete([], { kind: 'residue', projectKey: 'codex:residue' }, ['sessions'])).ok, false)
  assert.ok(Date.now() - started < 2000)
})

test('Codex workspace ownership compares slash variants and ignores malformed output mappings', async () => {
  const ws = join(home, 'workspaces', '2026-01-01', 'keep')
  await put(join(ws, 'outputs', 'a.txt'))
  db.prepare('INSERT INTO threads VALUES (?, ?, 1, 1, ?, ?, ?, NULL, 0)').run(id(2), 'other', 'vscode', ws.replaceAll('\\', '/'), 'Keep')
  await put(CODEX_GLOBAL_STATE, JSON.stringify({ 'thread-projectless-output-directories': { [id(1)]: join(ws, 'outputs') } }))
  assert.deepEqual((await scanCodexResidue()).folders, [])
  await put(CODEX_GLOBAL_STATE, JSON.stringify({ 'thread-projectless-output-directories': { [id(1)]: join(ws, 'unexpected') } }))
  assert.deepEqual((await scanCodexResidue()).folders, [])
})

test('Codex residue preserves remote assignments and their local image and output caches', async () => {
  const ws = join(home, 'workspaces', '2026-01-01', 'remote')
  await put(join(ws, 'outputs', 'a.txt'))
  await put(join(home, '.codex', 'generated_images', id(1), 'a.png'))
  await put(CODEX_GLOBAL_STATE, JSON.stringify({
    'thread-project-assignments': { [id(1)]: { projectKind: 'remote', projectId: 'remote' }, [id(2)]: { projectKind: 'remote', projectId: 'remote' } },
    'thread-projectless-output-directories': { [id(1)]: join(ws, 'outputs') },
    'electron-persisted-atom-state': { 'aeon-activity': { [id(1)]: 1 } },
  }))
  const r = await scanCodexResidue()
  assert.deepEqual(r.stateIds, [])
  assert.deepEqual(r.folders, [])
})

test('Grok residue includes orphan descendants in one cleanup and protects active descendants', async () => {
  const parent = await grokSession(id(1), null)
  const child = await grokSession(id(2), 'subagent', ['agent_message_chunk'], 'child-cwd')
  await put(join(parent, 'subagents', id(2), 'meta.json'), '{}')
  await age(join(home, '.grok'))
  const target = { kind: 'residue', projectKey: 'grok:residue' }
  await put(join(home, '.grok', 'active_sessions.json'), JSON.stringify([{ session_id: id(2), pid: process.pid }]))
  assert.deepEqual((await planDelete([], target)).items, [])
  await put(join(home, '.grok', 'active_sessions.json'), '[]')
  const plan = await planDelete([], target)
  assert.deepEqual(new Set(plan.items.map((x) => x.path)), new Set([parent, child]))
  assert.equal((await runDelete([], target, ['sessions', 'artifacts'])).ok, true)
  assert.ok(!existsSync(parent) && !existsSync(child))
})

test('Claude residue never discards shared history while another copy contains a conversation', async () => {
  await put(join(PROJECTS_DIR, 'a', id(1) + '.jsonl'), '{}\n')
  await put(join(PROJECTS_DIR, 'b', id(1) + '.jsonl'), '{"type":"assistant"}\n')
  const history = join(home, '.claude', 'file-history', id(1), 'backup')
  await put(history)
  await age(join(home, '.claude'))
  assert.equal((await runDelete([], { kind: 'residue', projectKey: 'residue' }, ['sessions', 'artifacts', 'history', 'temp'])).ok, true)
  assert.ok(existsSync(history))
  assert.deepEqual(trashed, [join(PROJECTS_DIR, 'a', id(1) + '.jsonl')])
})

test('Claude residue preserves memory still used by a listed project with transcripts in another folder', async () => {
  const p = project('claude', 'C:\\example', [version(id(1), 'copied')])
  await put(join(PROJECTS_DIR, 'copied', id(1) + '.jsonl'), '{"type":"assistant"}\n')
  await put(join(projectMemoryDir(p.path), 'MEMORY.md'))
  await age(PROJECTS_DIR)
  assert.deepEqual((await planDelete([p], { kind: 'residue', projectKey: 'residue' })).items, [])
})

test('Codex invalid Desktop state blocks cleanup instead of classifying remote data as orphaned', async () => {
  await codexResidueFixture()
  await put(CODEX_GLOBAL_STATE, '{')
  await assert.rejects(() => runDelete([], { kind: 'residue', projectKey: 'codex:residue' }, ['sessions', 'cache', 'artifacts']))
  assert.deepEqual(trashed, [])
  assert.deepEqual(cliCalls, [])
})

test('Claude duplicate version ids do not delete shared paths twice', async () => {
  const p = project('claude', 'C:\\example', [version(id(1), 'a')])
  p.sessions[0].versions.push(version(id(1), 'b'))
  await put(join(PROJECTS_DIR, 'a', id(1) + '.jsonl'))
  await put(join(PROJECTS_DIR, 'b', id(1) + '.jsonl'))
  const history = join(home, '.claude', 'file-history', id(1))
  await put(join(history, 'backup'))
  const r = await runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions', 'history'])
  assert.equal(r.ok, true)
  assert.equal(trashed.filter((p) => p === history).length, 1)
})

test('Claude attachment sizing and deletion never follow a junction into another folder', async () => {
  const p = project('claude', 'C:\\example', [version(id(1), 'a')])
  const external = join(home, 'external-package')
  await put(join(external, 'keep.bin'), Buffer.alloc(1024 * 1024))
  const artifacts = join(PROJECTS_DIR, 'a', id(1))
  await mkdir(artifacts, { recursive: true })
  await symlink(external, join(artifacts, 'node_modules'), 'junction')
  const target = { kind: 'project', projectKey: p.key }
  const plan = await planDelete([p], target)
  assert.ok(plan.items.find((x) => x.path === artifacts).bytes < 1024 * 1024)
  assert.equal((await runDelete([p], target, ['artifacts'])).ok, true)
  assert.equal((await readFile(join(external, 'keep.bin'))).length, 1024 * 1024)
  await rm(external, { recursive: true })
})

test('Codex project deletion covers descendants, keeps shared workspaces and backs up edited indexes', async () => {
  const workspace = join(home, 'workspaces', '2026-01-01', 'shared')
  await put(join(workspace, 'outputs', 'keep.txt'))
  for (const n of [1, 2, 3]) {
    const rollout = join(home, '.codex', 'sessions', `rollout-2026-01-01-${id(n)}.jsonl`)
    await put(rollout)
    db.prepare('INSERT INTO threads VALUES (?, ?, 1, 1, ?, ?, ?, NULL, 0)').run(id(n), rollout, n === 2 ? '{"subagent":{}}' : 'vscode', workspace, 'Fixture')
    await put(join(home, '.codex', 'generated_images', id(n), 'image.png'))
  }
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(id(1), id(2), 'done')
  const state = JSON.stringify({ 'projectless-thread-ids': [id(1), id(2), id(3)], 'thread-projectless-output-directories': { [id(1)]: join(workspace, 'outputs') } })
  await put(CODEX_GLOBAL_STATE, state)
  await put(CODEX_GLOBAL_STATE + '.bak', state)
  const p = project('codex', 'fixture', [version(id(1), '')])
  const target = { kind: 'project', projectKey: p.key }
  assert.ok(!(await planDelete([p], target)).items.some((x) => x.kind === 'output'))
  assert.equal((await runDelete([p], target, ['sessions', 'artifacts', 'output'])).ok, true)
  assert.deepEqual(cliCalls, [id(1)])
  assert.deepEqual(JSON.parse(await readFile(CODEX_GLOBAL_STATE, 'utf8'))['projectless-thread-ids'], [id(3)])
  assert.deepEqual(JSON.parse(await readFile(CODEX_GLOBAL_STATE + '.bak', 'utf8'))['projectless-thread-ids'], [id(3)])
  assert.ok(existsSync(workspace))
  assert.ok(existsSync(join(home, '.codex', 'generated_images', id(3))))
  const { readdir } = await import('node:fs/promises')
  const backups = await readdir(join(home, 'appdata', 'codex-backups'))
  assert.equal(await readFile(join(home, 'appdata', 'codex-backups', backups[0], '.codex-global-state.json'), 'utf8'), state)
})

test('Codex regular deletion failures preserve caches and files; deselecting sessions keeps the indexes', async () => {
  const rollout = await codexResidueFixture()
  db.prepare('INSERT INTO threads VALUES (?, ?, 1, 1, ?, ?, ?, NULL, 0)').run(id(1), rollout, 'vscode', home, 'Fixture')
  const p = project('codex', 'fixture', [version(id(1), '')])
  const target = { kind: 'session', projectKey: p.key, id: id(1) }
  const state = await readFile(CODEX_GLOBAL_STATE, 'utf8')
  rpcFailure = 'delete failed'
  rpcFailureAt = 'thread/delete'
  assert.equal((await runDelete([p], target, ['sessions', 'artifacts'])).ok, false)
  assert.equal(await readFile(CODEX_GLOBAL_STATE, 'utf8'), state)
  assert.deepEqual(trashed, [])
  cliCalls.length = 0
  assert.equal((await runDelete([p], target, ['artifacts'])).ok, true)
  assert.deepEqual(cliCalls, [])
  assert.equal(await readFile(CODEX_GLOBAL_STATE, 'utf8'), state)
  assert.ok(existsSync(rollout))
})

test('Codex residue preserves every rollout of an id when any copy changed recently', async () => {
  const old = await codexResidueFixture()
  await put(old.replace('.jsonl', `_${id(2)}.jsonl`))
  const plan = await planDelete([], { kind: 'residue', projectKey: 'codex:residue' })
  assert.ok(!plan.items.some((x) => x.kind === 'sessions'))
})

test('Codex residue finds deleted-thread entries left only in the backup state and prompt history', async () => {
  await put(CODEX_GLOBAL_STATE, '{}')
  const backup = JSON.stringify({ 'projectless-thread-ids': [id(1)] })
  await put(CODEX_GLOBAL_STATE + '.bak', backup)
  await put(join(home, '.codex', 'history.jsonl'), JSON.stringify({ session_id: id(1), text: 'Old prompt' }) + '\n')
  const target = { kind: 'residue', projectKey: 'codex:residue' }
  assert.ok((await planDelete([], target)).items.some((x) => x.kind === 'cache'))
  assert.equal((await runDelete([], target, ['cache'])).ok, true)
  assert.equal(await readFile(join(home, '.codex', 'history.jsonl'), 'utf8'), '')
  assert.deepEqual(JSON.parse(await readFile(CODEX_GLOBAL_STATE + '.bak', 'utf8'))['projectless-thread-ids'], [])
})

test('Grok metadata cannot escape a session folder through dot segments or Windows path aliases', async () => {
  await grokSession(id(1), null)
  await put(join(home, '.grok', 'sessions', 'updates.jsonl'), '\n')
  for (const unsafe of ['.', '..', '.. ', 'child.', 'C:', 'x/y', 'x\\y']) {
    assert.equal(await findGrokSessionDir(unsafe), null, unsafe)
  }
})

test('Codex backup ownership protects workspaces when remote or project entries are absent from current state', async () => {
  const ws = join(home, 'workspaces', '2026-01-01', 'keep')
  await put(join(ws, 'outputs', 'keep.txt'))
  await put(CODEX_GLOBAL_STATE, JSON.stringify({ 'thread-projectless-output-directories': { [id(1)]: join(ws, 'outputs') } }))
  await put(CODEX_GLOBAL_STATE + '.bak', JSON.stringify({
    'thread-projectless-output-directories': { [id(1)]: join(ws, 'outputs') },
    'electron-persisted-atom-state': { 'aeon-activity': { [id(1)]: 1 } },
  }))
  assert.deepEqual((await scanCodexResidue()).folders, [])
  await put(CODEX_GLOBAL_STATE + '.bak', JSON.stringify({ 'local-projects': { p: { id: 'p', rootPaths: [ws] } } }))
  assert.deepEqual((await scanCodexResidue()).folders, [])
})

const claudeRow = (type, body = {}) => ({ type, cwd: 'C:\\example', timestamp: '2026-01-01T00:00:00Z', ...body })
const claudeAnswer = (text) => claudeRow('assistant', { message: { id: 'answer', content: [{ type: 'text', text }], stop_reason: 'end_turn' } })
const claudeCommand = (text) => claudeRow('system', { subtype: 'local_command', content: `<command-name>${text}</command-name>` })
async function claudeSession(n, rows) {
  const path = join(PROJECTS_DIR, 'project', id(n) + '.jsonl')
  await put(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return path
}

test('Claude lists command-only and answer-only sessions in the secondary view, leaving empty logs unlisted', async () => {
  await claudeSession(1, [claudeCommand('/doctor'), claudeAnswer('Configuration checked')])
  await claudeSession(2, [claudeAnswer('Background report')])
  await claudeSession(3, [claudeCommand('/model')])
  await claudeSession(4, [])
  await claudeSession(5, [claudeRow('assistant', { message: { content: [{ type: 'thinking', thinking: 'hidden' }] } })])
  await claudeSession(6, [claudeRow('user', { origin: { kind: 'human' }, message: { content: 'A normal prompt' } })])
  const [p] = await new SessionIndex(join(home, 'appdata', 'claude-cache.json')).scan()
  const byId = Object.fromEntries(p.sessions.map((s) => [s.id, s]))
  assert.deepEqual(Object.keys(byId).sort(), [id(1), id(2), id(3), id(6)])
  assert.equal(p.path, 'C:\\example')
  assert.equal(byId[id(1)].title, '/doctor')
  assert.equal(byId[id(2)].title, 'Background report')
  assert.equal(byId[id(3)].title, '/model')
  for (const n of [1, 2, 3]) assert.equal(byId[id(n)].headless, true)
  assert.equal(byId[id(6)].headless, false)
  assert.equal(byId[id(6)].promptCount, 1)
  await age(PROJECTS_DIR)
  const residue = await planDelete([p], { kind: 'residue', projectKey: 'residue' })
  assert.deepEqual(residue.items.map((x) => x.path), [join(PROJECTS_DIR, 'project', id(4) + '.jsonl')])
})

test('Claude command sessions can be loaded, searched and deleted through the existing APIs', async () => {
  const file = await claudeSession(1, [claudeCommand('/doctor'), claudeAnswer('Configuration checked')])
  const projects = await new SessionIndex(join(home, 'appdata', 'claude-cache.json')).scan()
  const p = projects[0]
  assert.ok(p)
  const s = p.sessions.find((s) => s.id === id(1))
  const detail = await loadSession(p, s, s.versions[0])
  assert.deepEqual(detail.turns.map((t) => t.kind), ['command', 'assistant'])
  assert.equal(detail.turns[1].text, 'Configuration checked')
  const search = new SearchIndex()
  assert.equal((await search.search(projects, 'Configuration checked', false, 'claude')).results.length, 0)
  assert.equal((await search.search(projects, 'Configuration checked', true, 'claude')).results[0].id, id(1))
  assert.equal((await search.search(projects, '/doctor', true, 'claude')).results[0].id, id(1))
  assert.equal((await runDelete(projects, { kind: 'session', projectKey: p.key, id: id(1) }, ['sessions'])).ok, true)
  assert.ok(!existsSync(file))
})

test('Claude classification survives cache reload and switches back when a real prompt is appended', async () => {
  const file = await claudeSession(1, [claudeCommand('/model'), claudeAnswer('Model selected')])
  const cache = join(home, 'appdata', 'claude-cache.json')
  const st = await stat(file)
  await put(cache, JSON.stringify({ version: 5, files: {
    [file]: { size: st.size, mtimeMs: st.mtimeMs, offset: st.size, firstCwd: 'C:\\example', promptCount: 0, promptUuids: [], lastTs: 0 },
  } }))
  const index = new SessionIndex(cache)
  const initial = (await index.scan())[0]?.sessions[0]
  assert.ok(initial)
  assert.equal(initial.headless, true)
  assert.equal(initial.title, '/model')
  const reloaded = (await new SessionIndex(cache).scan())[0].sessions[0]
  assert.equal(reloaded.headless, true)
  assert.equal(reloaded.title, '/model')
  await appendFile(file, JSON.stringify(claudeRow('user', { origin: { kind: 'human' }, message: { content: 'Continue with a normal prompt' } })) + '\n')
  const updated = (await index.scan())[0].sessions[0]
  assert.equal(updated.headless, false)
  assert.equal(updated.promptCount, 1)
  assert.equal(updated.title, 'Continue with a normal prompt')
})

test('Grok answer-only sessions can be loaded, searched and deleted through the existing APIs', async () => {
  const dir = await grokSession(id(1), null)
  await put(join(dir, 'updates.jsonl'), JSON.stringify({ params: { update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Standalone Grok report' },
  } } }) + '\n')
  const projects = await new GrokIndex(join(home, 'appdata', 'grok-cache.json')).scan()
  const p = projects[0]
  assert.ok(p)
  const s = p.sessions.find((s) => s.id === id(1))
  assert.equal(s.headless, true)
  const detail = await loadGrokSession(p, s, s.versions[0])
  assert.deepEqual(detail.turns.map((t) => [t.kind, t.text]), [['assistant', 'Standalone Grok report']])
  const search = new SearchIndex()
  assert.equal((await search.search(projects, 'Standalone Grok report', false, 'grok')).results.length, 0)
  assert.equal((await search.search(projects, 'Standalone Grok report', true, 'grok')).results[0].id, id(1))
  assert.equal((await runDelete(projects, { kind: 'session', projectKey: p.key, id: id(1) }, ['sessions'])).ok, true)
  assert.ok(!existsSync(dir))
  assert.deepEqual(cliCalls, [id(1)])
})

test('Codex answer-only and empty indexed threads have search and deletion entries', async () => {
  for (const n of [1, 2]) {
    const rollout = join(home, '.codex', 'sessions', `rollout-2026-01-01-${id(n)}.jsonl`)
    await put(rollout)
    db.prepare('INSERT INTO threads VALUES (?, ?, 1, 1, ?, ?, NULL, NULL, 0)').run(id(n), rollout, 'vscode', 'C:\\example')
  }
  const history = new DatabaseSync(join(home, '.codex', 'thread_history_1.sqlite'))
  history.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
    created_at_ms INTEGER, item_json TEXT, item_type TEXT);`)
  history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id(1), 't1', 'answer', 1, 1000,
    JSON.stringify({ type: 'agentMessage', text: 'Standalone Codex report', phase: 'final_answer' }), 'agentMessage',
  )
  history.close()
  const projects = await scanCodex()
  const p = projects[0]
  assert.equal(p.sessions.length, 2)
  const s = p.sessions.find((s) => s.id === id(1))
  assert.equal(s.headless, false)
  assert.equal(loadCodexSession(p, s).turns[0].text, 'Standalone Codex report')
  const search = new SearchIndex()
  assert.equal((await search.search(projects, 'Standalone Codex report', false, 'codex')).results[0].id, id(1))
  for (const n of [1, 2]) {
    const target = { kind: 'session', projectKey: p.key, id: id(n) }
    assert.ok((await planDelete(projects, target)).items.some((x) => x.kind === 'sessions'))
    assert.equal((await runDelete(projects, target, ['sessions'])).ok, true)
  }
  assert.deepEqual(cliCalls, [id(1), id(2)])
})

test('Grok rejects malformed active-state shapes instead of treating them as no active sessions', async () => {
  await grokSession(id(1), null, ['user_message_chunk'])
  await put(join(home, '.grok', 'active_sessions.json'), 'null')
  const p = project('grok', 'cwd', [version(id(1), 'cwd')])
  assert.equal((await runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions'])).error?.code, 'grok-session-open')
  assert.deepEqual(cliCalls, [])
})

test('Grok keeps a descendant that becomes active while its parent is being deleted', async () => {
  const parent = await grokSession(id(1), null, ['user_message_chunk'])
  const child = await grokSession(id(2), 'subagent')
  await put(join(parent, 'subagents', id(2), 'meta.json'), '{}')
  afterGrokDelete = async (sid) => {
    if (sid === id(1)) await put(join(home, '.grok', 'active_sessions.json'), JSON.stringify([{ session_id: id(2), pid: process.pid }]))
  }
  const p = project('grok', 'cwd', [version(id(1), 'cwd')])
  assert.equal((await runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions'])).error?.code, 'grok-session-open')
  assert.ok(existsSync(child))
  assert.deepEqual(cliCalls, [id(1)])
})

test('Codex relative output mappings cannot turn the current directory into a cleanup root', async () => {
  await put(join(home, 'workspaces', '2026-01-01', 'keep', 'outputs', 'file.txt'))
  await put(CODEX_GLOBAL_STATE, JSON.stringify({ 'thread-projectless-output-directories': { [id(1)]: 'workspaces\\2026-01-01\\keep\\outputs' } }))
  const cwd = process.cwd()
  try {
    process.chdir(home)
    assert.deepEqual((await scanCodexResidue()).folders, [])
  } finally {
    process.chdir(cwd)
  }
})

test('Codex unavailable thread indexes are distinct from an unused workspace', async () => {
  const path = join(home, '.codex', 'state_5.sqlite')
  const moved = path + '.unavailable'
  db.close()
  await (await import('node:fs/promises')).rename(path, moved)
  try {
    assert.equal(codexThreadsIn('C:\\example'), null)
  } finally {
    await (await import('node:fs/promises')).rename(moved, path)
    db = new DatabaseSync(path)
  }
})

test('Codex deletes leftover rollout copies when both ids in the filename are selected', async () => {
  const rollouts = [1, 2].map((n) => join(home, '.codex', 'sessions', `rollout-2026-01-01-${id(n)}.jsonl`))
  for (const [i, path] of rollouts.entries()) {
    await put(path)
    db.prepare('INSERT INTO threads VALUES (?, ?, 1, 1, ?, ?, NULL, NULL, 0)').run(id(i + 1), path, i === 0 ? 'vscode' : '{"subagent":{}}', 'C:\\example')
  }
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(id(1), id(2), 'done')
  const extra = rollouts[0].replace('.jsonl', `_${id(2)}.jsonl`)
  await put(extra)
  const p = project('codex', 'fixture', [version(id(1), '')])
  assert.equal((await runDelete([p], { kind: 'project', projectKey: p.key }, ['sessions'])).ok, true)
  assert.ok(!existsSync(extra))
  assert.deepEqual(trashed, [extra])
})

for (const residue of [false, true]) test(`Codex ${residue ? 'residue' : 'session'} cleanup keeps caches when Desktop opens during thread/delete`, async () => {
  const rollout = await codexResidueFixture()
  const projects = []
  let target = { kind: 'residue', projectKey: 'codex:residue' }
  if (!residue) {
    db.prepare('INSERT INTO threads VALUES (?, ?, 1, 1, ?, ?, NULL, NULL, 0)').run(id(1), rollout, 'vscode', 'C:\\example')
    const p = project('codex', 'fixture', [version(id(1), '')])
    projects.push(p)
    target = { kind: 'session', projectKey: p.key, id: id(1) }
  }
  const before = await readFile(CODEX_GLOBAL_STATE, 'utf8')
  startDesktopOnDelete = true
  assert.equal((await runDelete(projects, target, ['sessions', 'cache', 'artifacts', 'output'])).error?.code, 'codex-running')
  assert.equal(await readFile(CODEX_GLOBAL_STATE, 'utf8'), before)
  assert.deepEqual(trashed, [])
})
