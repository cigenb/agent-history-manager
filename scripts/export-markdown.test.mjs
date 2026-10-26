import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportMarkdown, markdownFileName } from '../src/renderer/src/lib/exportMarkdown.ts'
import zh from '../src/renderer/src/i18n/zh.ts'
import en from '../src/renderer/src/i18n/en.ts'
import { Store } from '../src/main/store.ts'

const time = new Date(2026, 0, 2, 12).getTime()
const conversation = (turns) => ({
  source: 'claude', id: 'example-version', familyId: 'example-family', projectKey: '/example',
  path: '/example/project', versions: [], firstTime: time - 86_400_000, lastTime: time, turns,
})

test('exports only prompts, image placeholders, and final answers in message order', () => {
  const turns = [
    { kind: 'command', text: '/model excluded-slash', time: time - 100 },
    { kind: 'user', text: '<system-reminder>excluded-reminder</system-reminder>\nExample prompt', images: [{ data: 'excluded-base64', mediaType: 'image/png' }], time },
    { kind: 'assistant', text: 'Final **answer**\n\n```ts\nconst example = true\n```', steps: ['excluded-process'], edits: [{ path: 'excluded-edit.md', kind: 'write', hunks: [{ old: '', new: 'excluded-diff' }] }], time },
    { kind: 'command', text: '! excluded-bash', time },
    { kind: 'compact', time },
    { kind: 'assistant', text: '', steps: ['excluded-empty'], edits: [], time },
    { kind: 'user', text: ' ', images: [], time },
    { kind: 'user', text: '', images: [{ data: 'excluded-image-only', mediaType: 'image/png' }], time },
  ]
  const markdown = exportMarkdown(conversation(turns), 'Example "title"', new Date('2026-01-03T00:00:00Z'))
  assert.ok(!markdown.includes('excluded-'))
  assert.ok(markdown.startsWith('---\ntitle: "Example \\"title\\""\ndate: 2026-01-02\nexported: 2026-01-03T00:00:00.000Z\n'))
  assert.ok(markdown.includes('project: "/example/project"\nsession: "example-version"\nsource: Claude Code\n---\n\n# Example "title"'))
  assert.ok(markdown.includes('### **Human**\n\n*[Image]*\n\nExample prompt'))
  assert.ok(markdown.includes('### **Claude**\n\nFinal **answer**\n\n```ts\nconst example = true\n```'))
  assert.equal(markdown.match(/### \*\*Human\*\*/g).length, 2)
  assert.equal(markdown.match(/### \*\*Claude\*\*/g).length, 1)
  assert.ok(markdown.endsWith('---\n\n### **Human**\n\n*[Image]*\n'))
})

test('uses the selected file ID and safely quotes YAML metadata', () => {
  const detail = conversation([{ kind: 'user', text: 'Example', images: [], time }])
  detail.path = 'example: project # folder'
  const title = 'Example "title"\nnext line'
  const markdown = exportMarkdown(detail, title)
  assert.equal(JSON.parse(markdown.split('\n')[1].slice('title: '.length)), title)
  assert.ok(markdown.includes(`project: ${JSON.stringify(detail.path)}`))
  assert.ok(markdown.includes('session: "example-version"'))
  assert.ok(!markdown.includes('example-family'))
  assert.ok(markdown.includes('# Example "title" next line\n'))
})

test('empty or command-only conversations have no message headings', () => {
  for (const turns of [[], [{ kind: 'command', text: '/model', time }]]) {
    const markdown = exportMarkdown(conversation(turns), 'Example')
    assert.ok(!markdown.includes('### **'))
    assert.ok(!markdown.includes('Invalid Date'))
  }
})

test('sanitizes Windows file names, reserved device names, and blank titles', () => {
  assert.equal(markdownFileName('Example: title?'), 'Example_ title_.md')
  assert.equal(markdownFileName('CON'), '_CON.md')
  assert.equal(markdownFileName('nul.txt'), '_nul.txt.md')
  assert.equal(markdownFileName(' ... '), 'conversation.md')
  assert.equal(markdownFileName('a'.repeat(150)).length, 103)
  assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(markdownFileName('a/b\\c\n')))
})

test('dictionaries match and English count labels handle zero, one, and many', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  assert.equal(en.versions(1), '1 version')
  assert.equal(en.versions(3), '3 versions')
  assert.equal(en.steps(1), '1 step in between')
  assert.equal(en.steps(0), '0 steps in between')
  assert.equal(en.memoryCount(1), 'Memory index · 1 memory')
  assert.equal(en.memoryCount(3), 'Memory index · 3 memories')
  assert.equal(en.prompts(1), '1 prompt')
  assert.equal(en.conversations(1), '1 conversation')
  assert.equal(en.items(1), '1 item')
  assert.ok(!en.deleteVersions(1).includes('1 versions'))
})

test('language preference survives Store reload and unrelated UI changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-viewer-state-test-'))
  try {
    const path = join(directory, 'state.json')
    await writeFile(path, JSON.stringify({ ui: { projectOrder: ['example'], expanded: [], showTemp: false, sessionOrder: {} } }))
    const store = new Store(path)
    assert.equal(store.data.ui.language, undefined)
    assert.equal(store.getUi('zh-CN').language, 'zh')
    assert.equal(store.getUi('zh-TW').language, 'zh')
    assert.equal(store.getUi('en-US').language, 'en')
    assert.equal(store.getUi('fr-FR').language, 'en')
    store.setUi({ language: 'en' })
    store.setUi({ expanded: ['example'] })
    store.flush()
    assert.equal(new Store(path).getUi('zh-CN').language, 'en')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).ui.expanded, ['example'])
    assert.deepEqual(store.data.ui.projectOrder, ['example'])
  } finally {
    await rm(directory, { recursive: true })
  }
})
