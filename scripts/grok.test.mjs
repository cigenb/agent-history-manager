import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { exportMarkdown } from '../src/renderer/src/lib/exportMarkdown.ts'

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

const home = await mkdtemp(join(tmpdir(), 'grok-history-'))
process.env.GROK_HOME = home
const { GrokIndex, grokSearchText, loadGrokAgent, readGrokAgents, readGrokTurns } = await import('../src/main/grok.ts')

const cwd = 'C:\\example\\project'
const folder = join(home, 'sessions', encodeURIComponent(cwd))
const parent = 'parent-session'
const child = 'child-session'

let ms = 1_000_000
const record = (update, meta = {}) =>
  JSON.stringify({ timestamp: 1, method: 'session/update', params: { sessionId: parent, update, _meta: { agentTimestampMs: (ms += 1000), ...meta } } })
const user = (text, promptIndex) => record({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex } })
const agent = (text) => record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

async function session(id, summary, lines) {
  const dir = join(folder, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd }, ...summary }))
  await writeFile(join(dir, 'updates.jsonl'), lines.join('\n') + '\n')
  return dir
}

const parentDir = await session(parent, { generated_title: 'Build check', last_active_at: '2026-01-02T00:00:00Z' }, [
  user('<system-reminder>injected</system-reminder>Check the build', 0),
  agent('Let me '),
  agent('check.'),
  record({ sessionUpdate: 'tool_call', toolCallId: 'a' }),
  record({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden thinking' } }),
  record({ sessionUpdate: 'subagent_spawned', child_session_id: child, description: 'Read file', subagent_type: 'general-purpose' }),
  agent('Final '),
  agent('answer'),
  record({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
  agent('Background job finished'),
  record({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
  user('Second ', 1),
  user('prompt', 1),
  record({ sessionUpdate: 'user_message_chunk', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' }, _meta: { promptIndex: 1 } }),
  agent('Done'),
])
await mkdir(join(parentDir, 'subagents', child), { recursive: true })
await writeFile(
  join(parentDir, 'subagents', child, 'meta.json'),
  JSON.stringify({ child_session_id: child, description: 'Read file', subagent_type: 'general-purpose', status: 'completed', tool_calls: 2, effective_model_id: 'grok-4.7' }),
)
await session(child, { session_kind: 'subagent' }, [user('Read marker.txt', 0), agent('MARKER')])
await session('headless-session', { session_kind: 'headless', generated_title: 'Script' }, [user('Run tests', 0), agent('ok')])
await session('empty-session', {}, [agent('no prompt')])

test.after(() => rm(home, { recursive: true, force: true }))

test('builds prompts, final answers, steps, resumes and subagents from chunked updates', async () => {
  const agents = await readGrokAgents(parentDir)
  const { turns } = await readGrokTurns(join(parentDir, 'updates.jsonl'), agents)
  assert.deepEqual(turns.map((t) => t.kind), ['user', 'assistant', 'resume', 'assistant', 'user', 'assistant'])
  assert.equal(turns[0].text, 'Check the build')
  assert.equal(turns[1].text, 'Final answer')
  assert.deepEqual(turns[1].steps, ['Let me check.'])
  assert.deepEqual(turns[1].agents, [{ id: child, description: 'Read file', type: 'general-purpose', model: 'grok-4.7', state: 'done', toolCalls: 2 }])
  assert.equal(turns[3].text, 'Background job finished')
  assert.equal(turns[4].text, 'Second prompt')
  assert.deepEqual(turns[4].images, [{ mediaType: 'image/png', data: 'AAAA' }])
  assert.ok(!JSON.stringify(turns).includes('hidden thinking'))
})

test('lists top-level sessions by working directory and hides child and empty sessions', async () => {
  const index = new GrokIndex(join(home, 'cache.json'))
  const [project] = await index.scan()
  assert.equal(project.source, 'grok')
  assert.equal(project.key, 'grok:c:\\example\\project')
  const byId = Object.fromEntries(project.sessions.map((s) => [s.id, s]))
  assert.deepEqual(Object.keys(byId).sort(), ['headless-session', parent])
  assert.equal(byId[parent].title, 'Build check')
  assert.equal(byId[parent].promptCount, 2)
  assert.equal(byId['headless-session'].headless, true)
  // Unchanged files come from the cache on the next scan.
  const again = await new GrokIndex(join(home, 'cache.json')).scan()
  assert.equal(again[0].sessions.find((s) => s.id === parent).promptCount, 2)
})

test('loads a subagent session and indexes the shown text for search', async () => {
  const version = { id: parent, dir: encodeURIComponent(cwd), title: '', lastActivity: 0, promptCount: 2 }
  const detail = await loadGrokAgent(version, child)
  assert.equal(detail.run.description, 'Read file')
  assert.equal(detail.turns.at(-1).text, 'MARKER')
  const text = await grokSearchText(join(parentDir, 'updates.jsonl'))
  assert.ok(text.includes('Let me check.') && text.includes('Final answer') && text.includes('Second prompt'))
})

test('exports Grok answers under a Grok heading', () => {
  const detail = { source: 'grok', id: 'x', familyId: 'x', projectKey: 'grok:x', path: cwd, versions: [], firstTime: 0, lastTime: 0,
    turns: [{ kind: 'user', text: 'Q', images: [], time: 1 }, { kind: 'assistant', text: 'A', steps: [], edits: [], agents: [], mcp: [], time: 2 }] }
  const md = exportMarkdown(detail, 'T', new Date('2026-01-03T00:00:00Z'))
  assert.ok(md.includes('source: Grok') && md.includes('### **Grok**\n\nA'))
})
