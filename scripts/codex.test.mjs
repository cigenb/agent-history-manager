import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

// The main process imports siblings without extensions (the bundler resolves them); Node needs `.ts`.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw e
      return next(specifier + '.ts', context)
    }
  },
})

const home = await mkdtemp(join(tmpdir(), 'codex-history-'))
process.env.CODEX_HOME = home
const { codexDescendants, forgetThreads, loadCodexSession, scanCodex } = await import('../src/main/codex.ts')

const db = new DatabaseSync(join(home, 'state_5.sqlite'))
db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT,
  title TEXT, first_user_message TEXT, archived INTEGER);
  CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`)
const add = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
add.run('assigned', 'r1', 100, 200, 'vscode', 'C:\\work\\app\\src', 'Assigned thread', null, 0)
add.run('by-root', 'r2', 100, 300, 'vscode', 'c:\\WORK\\app\\docs', '', 'First line\nmore', 1)
add.run('loose', 'r3', 100, 400, 'vscode', 'C:\\Users\\me\\Documents\\Codex\\x', 'Loose', null, 0)
add.run('script', 'r4', 100, 500, 'exec', 'C:\\elsewhere', 'Script', null, 0)
add.run('child', 'r5', 100, 600, '{"subagent":{}}', 'C:\\work\\app', 'Child', null, 0)
add.run('grandchild', 'r6', 100, 700, '{"subagent":{}}', 'C:\\work\\app', 'Grandchild', null, 0)
db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('assigned', 'child', 'closed')
db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('child', 'grandchild', 'closed')
db.close()

const state = {
  'local-projects': { p1: { id: 'p1', name: 'App', rootPaths: ['C:\\work\\app'] } },
  'thread-project-assignments': { assigned: { projectKind: 'local', projectId: 'p1' } },
  'projectless-thread-ids': ['loose'],
  'thread-projectless-output-directories': { loose: 'C:\\Users\\me\\Documents\\Codex\\x' },
}
await writeFile(join(home, '.codex-global-state.json'), JSON.stringify(state))

test.after(() => rm(home, { recursive: true, force: true }))

test('groups top-level threads like Codex Desktop and hides subagents', async () => {
  const projects = await scanCodex()
  const byKey = Object.fromEntries(projects.map((p) => [p.key, p]))
  assert.deepEqual(Object.keys(byKey).sort(), ['codex:c:\\elsewhere', 'codex:project:p1', 'codex:projectless'])
  const app = byKey['codex:project:p1']
  assert.equal(app.name, 'App')
  assert.deepEqual(app.sessions.map((s) => s.id), ['by-root', 'assigned'])
  assert.equal(app.sessions[0].title, 'First line')
  assert.equal(app.sessions[0].archived, true)
  assert.equal(byKey['codex:projectless'].projectless, true)
  assert.equal(byKey['codex:c:\\elsewhere'].sessions[0].headless, true)
})

test('finds subagent threads at any depth and loads facts without content', async () => {
  assert.deepEqual(codexDescendants(['assigned']).map((t) => t.id), ['child', 'grandchild'])
  const [project] = (await scanCodex()).filter((p) => p.key === 'codex:project:p1')
  const detail = loadCodexSession(project, project.sessions[1])
  assert.deepEqual(detail.codex, { cwd: 'C:\\work\\app\\src', archived: false, subagents: 2 })
  assert.deepEqual(detail.turns, [])
})

test('forgets every key and list item that mentions a deleted thread', () => {
  const input = {
    'projectless-thread-ids': ['loose', 'keep'],
    'thread-projectless-output-directories': { loose: 'C:\\x', keep: 'C:\\y' },
    'electron-persisted-atom-state': { 'thread-workspace-state-v1:loose': {}, other: 1 },
    orders: { p: [{ id: 'loose' }, { id: 'keep' }] },
  }
  const { value, removed } = forgetThreads(input, ['loose'])
  assert.equal(removed, 4)
  assert.deepEqual(value, {
    'projectless-thread-ids': ['keep'],
    'thread-projectless-output-directories': { keep: 'C:\\y' },
    'electron-persisted-atom-state': { other: 1 },
    orders: { p: [{ id: 'keep' }] },
  })
})
