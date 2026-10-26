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
const { codexDescendants, forgetThreads, loadCodexAgent, loadCodexSession, scanCodex } = await import('../src/main/codex.ts')

const db = new DatabaseSync(join(home, 'state_5.sqlite'))
db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT,
  title TEXT, first_user_message TEXT, archived INTEGER, model TEXT);
  CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`)
const add = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
add.run('assigned', 'r1', 100, 200, 'vscode', 'C:\\work\\app\\src', 'Assigned thread', null, 0, 'm')
add.run('by-root', 'r2', 100, 300, 'vscode', 'c:\\WORK\\app\\docs', '', 'First line\nmore', 1, 'm')
add.run('long-path', 'r7', 100, 350, 'vscode', '\\\\?\\C:\\work\\app', '# Files mentioned by the user:\n\n## a.png: C:\\a.png\n\n## My request for Codex:\nFix it', null, 0, 'm')
add.run('loose', 'r3', 100, 400, 'vscode', 'C:\\Users\\me\\Documents\\Codex\\x', 'Loose', null, 0, 'm')
add.run('script', 'r4', 100, 500, 'exec', 'C:\\elsewhere', 'Script', null, 0, 'm')
add.run('child', 'r5', 100, 600, '{"subagent":{"thread_spawn":{"agent_path":"/root/audit_docs","agent_nickname":"Ada"}}}', 'C:\\work\\app', 'Child', null, 0, 'sub-model')
add.run('grandchild', 'r6', 100, 700, '{"subagent":{}}', 'C:\\work\\app', 'Grandchild', null, 0, 'm')
db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('assigned', 'child', 'open')
db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('child', 'grandchild', 'open')
db.close()

const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'))
history.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER,
  item_json TEXT, item_type TEXT); CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT);`)
let ordinal = 0
const item = (thread, turn, type, body) =>
  history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)').run(thread, turn, String(ordinal), ++ordinal, 1000 + ordinal, JSON.stringify({ type, ...body }), type)
const text = (t) => ({ content: [{ type: 'text', text: t }] })
item('assigned', 't1', 'userMessage', text('# Files mentioned by the user:\n\n## x.png: C:\\x.png\n\n## My request:\nCheck the build'))
item('assigned', 't1', 'agentMessage', { text: 'Looking around.', phase: 'commentary' })
item('assigned', 't1', 'commandExecution', { command: 'ls' })
item('assigned', 't1', 'subAgentActivity', { agentThreadId: 'child', kind: 'spawn' })
item('assigned', 't1', 'mcpToolCall', { server: 'docs', tool: 'search', status: 'completed' })
item('assigned', 't1', 'reasoning', { summary: ['hidden thinking'] })
item('assigned', 't1', 'agentMessage', { text: 'Build is fine.', phase: 'final_answer' })
item('assigned', 't2', 'agentMessage', { text: 'Subagent reported back.', phase: 'final_answer' })
item('assigned', 't3', 'contextCompaction', {})
item('assigned', 't3', 'userMessage', text('Next'))
item('child', 'c1', 'userMessage', text('Audit docs'))
item('child', 'c1', 'fileChange', {})
item('child', 'c1', 'agentMessage', { text: 'Docs ok', phase: 'final_answer' })
history.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?)').run('child', 'c1', 1, 'completed')
history.close()

const state = {
  'local-projects': { p1: { id: 'p1', name: 'App', rootPaths: ['C:\\work\\app'] } },
  'thread-project-assignments': { assigned: { projectKind: 'local', projectId: 'p1' } },
  'projectless-thread-ids': ['loose'],
  'thread-projectless-output-directories': { loose: 'C:\\Users\\me\\Documents\\Codex\\x' },
}
await writeFile(join(home, '.codex-global-state.json'), JSON.stringify(state))
await writeFile(join(home, 'session_index.jsonl'), [{ id: 'loose', thread_name: 'Old name' }, { id: 'loose', thread_name: 'Renamed' }].map((r) => JSON.stringify(r)).join('\n'))

test.after(() => rm(home, { recursive: true, force: true }))

test('groups top-level threads like Codex Desktop and hides subagents', async () => {
  const projects = await scanCodex()
  const byKey = Object.fromEntries(projects.map((p) => [p.key, p]))
  assert.deepEqual(Object.keys(byKey).sort(), ['codex:c:\\elsewhere', 'codex:project:p1', 'codex:projectless'])
  const app = byKey['codex:project:p1']
  assert.equal(app.name, 'App')
  // A long-path (\\?\) working folder belongs to the same project as the plain path.
  assert.deepEqual(app.sessions.map((s) => s.id), ['long-path', 'by-root', 'assigned'])
  assert.equal(app.sessions[0].title, 'Fix it')
  assert.equal(app.sessions[1].title, 'First line')
  assert.equal(app.sessions[1].archived, true)
  assert.equal(byKey['codex:projectless'].projectless, true)
  assert.equal(byKey['codex:projectless'].sessions[0].title, 'Renamed')
  assert.equal(byKey['codex:c:\\elsewhere'].sessions[0].headless, true)
})

test('builds prompts, final answers, steps, subagents and MCP calls from Codex history items', async () => {
  assert.deepEqual(codexDescendants(['assigned']).map((t) => t.id), ['child', 'grandchild'])
  const [project] = (await scanCodex()).filter((p) => p.key === 'codex:project:p1')
  const { turns } = loadCodexSession(project, project.sessions.find((s) => s.id === 'assigned'))
  assert.deepEqual(turns.map((t) => t.kind), ['user', 'assistant', 'resume', 'assistant', 'compact', 'user'])
  assert.equal(turns[0].text, 'Check the build')
  assert.equal(turns[1].text, 'Build is fine.')
  assert.deepEqual(turns[1].steps, ['Looking around.'])
  assert.deepEqual(turns[1].agents, [{ id: 'child', description: 'audit_docs', type: 'Ada', model: 'sub-model', state: 'done', toolCalls: 1 }])
  assert.deepEqual(turns[1].mcp, [{ server: 'docs', tool: 'search', count: 1, state: 'done' }])
  assert.equal(turns[3].text, 'Subagent reported back.')
  assert.ok(!JSON.stringify(turns).includes('hidden thinking'))
  const agent = loadCodexAgent('assigned', 'child')
  assert.equal(agent.turns.at(-1).text, 'Docs ok')
  assert.equal(loadCodexAgent('assigned', 'grandchild').run.id, 'grandchild')
  assert.equal(loadCodexAgent('by-root', 'child'), null)
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
