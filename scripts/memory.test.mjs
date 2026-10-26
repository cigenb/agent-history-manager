import assert from 'node:assert/strict'
import { createReadStream, promises as disk } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'

const home = await disk.mkdtemp(join(tmpdir(), 'history-memory-'))
let failRead = null
let failWrite = null
const inside = (path) => {
  const rel = relative(home, resolve(path))
  assert.ok(rel && !rel.startsWith('..'), path)
}
const io = { ...disk }
for (const name of ['mkdir', 'mkdtemp', 'writeFile', 'rename', 'copyFile', 'unlink', 'rm']) {
  io[name] = async (...args) => {
    inside(args[0])
    if (name === 'rename' || name === 'copyFile') inside(args[1])
    if (name === 'writeFile' && args[0] === failWrite) throw Object.assign(new Error('fixture write denied'), { code: 'EACCES' })
    return disk[name](...args)
  }
}
io.readFile = async (...args) => {
  if (args[0] === failRead) throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' })
  return disk.readFile(...args)
}
globalThis.memoryTest = { home, io, createReadStream }
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:os' || specifier === 'node:fs') return { url: 'memory-test:' + specifier, shortCircuit: true }
    try { return next(specifier, context) } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw e
      return next(specifier + '.ts', context)
    }
  },
  load(url, context, next) {
    if (url === 'memory-test:node:os') return { format: 'module', shortCircuit: true, source: 'export const homedir = () => globalThis.memoryTest.home' }
    if (url === 'memory-test:node:fs') return { format: 'module', shortCircuit: true, source: 'export const promises = globalThis.memoryTest.io; export const createReadStream = globalThis.memoryTest.createReadStream' }
    return next(url, context)
  },
})
const { getProjectMemory, listMemoryBackups, planMemoryDelete, restoreMemoryBackup, runMemoryDelete } = await import('../src/main/memory.ts')
const { projectMemoryDir } = await import('../src/main/sessions.ts')
const { DELETED_NOTES } = await import('../src/shared/types.ts')
const project = { source: 'claude', key: 'c:\\example\\alpha', path: 'C:\\example\\alpha', sessions: [] }
const dir = projectMemoryDir(project.path)
const backupRoot = join(home, 'backups')
const put = async (file, text) => {
  inside(file)
  await disk.mkdir(dirname(file), { recursive: true })
  await disk.writeFile(file, text)
}
const seed = async (files) => {
  for (const [name, text] of Object.entries(files)) await put(join(dir, name), text)
}
const remove = (file = 'target.md', note = DELETED_NOTES.en) => runMemoryDelete(project, file, new Set(), backupRoot, note)
const read = (file) => disk.readFile(join(dir, file), 'utf8')
const backup = async () => (await listMemoryBackups(project, backupRoot))[0]

test.beforeEach(async () => {
  failRead = failWrite = null
  for (const name of ['.claude', 'backups', 'other', 'old-memory']) {
    const path = join(home, name)
    inside(path)
    await disk.rm(path, { recursive: true, force: true })
  }
})
test.after(() => disk.rm(home, { recursive: true, force: true }))

test('memory index recognizes only local links and ignores intentional deletion marks', async () => {
  await seed({
    'MEMORY.md': [
      '- [External](https://example.com/target.md)',
      '- [Other directory](../target.md)',
      '- [Other child](nested/target.md)',
      '- [Local](./local.md#section)',
      `See ~~[Deleted](missing.md)~~${DELETED_NOTES.en}`,
      `See ~~[Deleted](missing-zh.md)~~${DELETED_NOTES.zh}`,
    ].join('\n'),
    'target.md': 'Target memory', 'local.md': 'Local memory',
  })
  const memory = await getProjectMemory(project)
  assert.equal(memory.files.find((f) => f.file === 'target.md').indexed, false)
  assert.equal(memory.files.find((f) => f.file === 'local.md').title, 'Local')
  assert.deepEqual(memory.missing, [])
})

test('deleting one memory preserves other links, other projects and filenames with regex characters', async () => {
  const other = { ...project, key: 'c:\\example\\beta', path: 'C:\\example\\beta' }
  const otherFile = join(projectMemoryDir(other.path), 'a+b.md')
  await put(otherFile, 'Other project memory')
  await seed({
    'MEMORY.md': '- [Target](a+b.md)\n- [Keep](keep.md)\n- [Target](a+b.md) and [Website](https://example.com)\n',
    'a+b.md': '---\nname: Target name\n---\nTarget body',
    'keep.md': [
      '[Local](a+b.md) and [Relative](./A+B.MD) and [Anchor](a+b.md#details)',
      '[[a+b]] [[Target name|label]]',
      '[Other](ab.md) [Nested](nested/a+b.md) [External](https://example.com/a+b.md)',
    ].join('\n'),
  })
  assert.equal((await remove('a+b.md')).ok, true)
  const index = await read('MEMORY.md')
  assert.ok(index.includes('- [Keep](keep.md)'))
  assert.ok(index.includes(`- ~~[Target](a+b.md)~~${DELETED_NOTES.en} and [Website](https://example.com)`))
  assert.ok(!index.startsWith('- [Target](a+b.md)\n'))
  const kept = await read('keep.md')
  assert.ok(kept.includes(`~~[Local](a+b.md)~~${DELETED_NOTES.en}`))
  assert.ok(kept.includes(`~~[Anchor](a+b.md#details)~~${DELETED_NOTES.en}`))
  assert.ok(kept.includes(`~~[[Target name|label]]~~${DELETED_NOTES.en}`))
  assert.ok(kept.includes('[Other](ab.md) [Nested](nested/a+b.md) [External](https://example.com/a+b.md)'))
  assert.equal(await disk.readFile(otherFile, 'utf8'), 'Other project memory')
})

test('memory rewrites leave code examples and already marked links unchanged', async () => {
  const code = '```markdown\n- [Example](target.md)\n```\n'
  const marked = `~~[Old](target.md)~~${DELETED_NOTES.zh}`
  await seed({
    'MEMORY.md': code,
    'target.md': 'Target',
    'refs.md': `Use \`[Example](target.md)\` literally.\n${code}${marked}\nSee [Real](target.md).\n`,
  })
  assert.equal((await getProjectMemory(project)).files.find((f) => f.file === 'target.md').indexed, false)
  assert.equal((await remove()).ok, true)
  assert.equal(await read('MEMORY.md'), code)
  const refs = await read('refs.md')
  assert.ok(refs.includes('Use `[Example](target.md)` literally.'))
  assert.ok(refs.includes(code))
  assert.ok(refs.includes(marked))
  assert.ok(refs.includes(`~~[Real](target.md)~~${DELETED_NOTES.en}`))
  assert.equal((await remove()).error.code, 'memory-missing')
  assert.equal(await read('refs.md'), refs)
})

test('ambiguous wiki names never mark another memory as deleted', async () => {
  await seed({
    'target.md': '---\nname: Shared name\n---\nTarget',
    'keep.md': '---\nname: Shared name\n---\nKeep',
    'refs.md': '[[Shared name]] and [[target]] and [[keep]]',
  })
  assert.equal((await remove()).ok, true)
  assert.equal(await read('refs.md'), `[[Shared name]] and ~~[[target]]~~${DELETED_NOTES.en} and [[keep]]`)
})

test('memory deletion backs up originals and restores CRLF files exactly', async () => {
  const files = { 'MEMORY.md': '- [Target](target.md)\r\n- [Keep](refs.md)\r\n', 'target.md': 'Target\r\n', 'refs.md': 'See [Target](target.md).\r\n' }
  await seed(files)
  assert.equal((await remove()).ok, true)
  const b = await backup()
  assert.deepEqual(b.changed, [])
  for (const [file, text] of Object.entries(files)) assert.equal(await disk.readFile(join(backupRoot, b.id, file), 'utf8'), text)
  assert.equal((await restoreMemoryBackup(project, b.id, [], backupRoot)).ok, true)
  for (const [file, text] of Object.entries(files)) assert.equal(await read(file), text)
  assert.deepEqual(await listMemoryBackups(project, backupRoot), [])
})

test('restore rejects newly changed files before copying anything, including changes after confirmation', async () => {
  await seed({ 'MEMORY.md': '- [Target](target.md)\n', 'target.md': 'Target', 'refs.md': '[Target](target.md)' })
  assert.equal((await remove()).ok, true)
  const b = await backup()
  await put(join(dir, 'refs.md'), 'Later change')
  await disk.utimes(join(dir, 'refs.md'), new Date(0), new Date(0))
  assert.equal((await restoreMemoryBackup(project, b.id, [], backupRoot)).error.code, 'backup-changed')
  const warned = await backup()
  await put(join(dir, 'MEMORY.md'), 'Another later change')
  await disk.utimes(join(dir, 'MEMORY.md'), new Date(0), new Date(0))
  assert.equal((await restoreMemoryBackup(project, b.id, warned.changed, backupRoot)).error.code, 'backup-changed')
  await assert.rejects(() => disk.stat(join(dir, 'target.md')), { code: 'ENOENT' })
  assert.equal(await read('refs.md'), 'Later change')
  assert.equal(await read('MEMORY.md'), 'Another later change')
  assert.equal((await restoreMemoryBackup(project, b.id, (await backup()).changed, backupRoot)).ok, true)
})

test('MEMORY.md, path traversal and another project backup cannot be deleted or restored', async () => {
  await seed({ 'MEMORY.md': '- [Target](target.md)', 'target.md': 'Target' })
  assert.equal(await planMemoryDelete(project, 'MEMORY.md', new Set(), DELETED_NOTES.en), null)
  assert.equal((await remove('../MEMORY.md')).error.code, 'memory-missing')
  assert.equal((await remove()).ok, true)
  const b = await backup()
  const other = { ...project, path: 'C:\\example\\beta' }
  assert.equal((await restoreMemoryBackup(other, b.id, [], backupRoot)).error.code, 'backup-missing')
  const manifestFile = join(backupRoot, b.id, 'manifest.json')
  const manifest = JSON.parse(await disk.readFile(manifestFile, 'utf8'))
  manifest.rewritten[0].file = '../../../../outside.md'
  await disk.writeFile(manifestFile, JSON.stringify(manifest))
  assert.equal((await restoreMemoryBackup(project, b.id, ['../../../../outside.md'], backupRoot)).error.code, 'backup-missing')
})

test('unreadable references and backup creation failures leave the memory untouched', async () => {
  await seed({ 'MEMORY.md': '- [Target](target.md)', 'target.md': 'Target', 'refs.md': '[Target](target.md)' })
  failRead = join(dir, 'refs.md')
  const failed = await remove()
  assert.equal(failed.ok, false)
  assert.equal(await read('target.md'), 'Target')
  failRead = null
  await put(backupRoot, 'Not a directory')
  assert.equal((await remove()).ok, false)
  assert.equal(await read('target.md'), 'Target')
  assert.equal(await read('MEMORY.md'), '- [Target](target.md)')
})

test('failed reference writes remain recoverable and are flagged for overwrite confirmation', async () => {
  await seed({ 'MEMORY.md': '- [Target](target.md)', 'target.md': 'Target', 'refs.md': '[Target](target.md)' })
  failWrite = join(dir, 'refs.md')
  assert.equal((await remove()).error.code, 'memory-update-failed')
  failWrite = null
  const b = await backup()
  assert.ok(b.changed.includes('refs.md'))
  assert.equal((await restoreMemoryBackup(project, b.id, b.changed, backupRoot)).ok, true)
  assert.equal(await read('target.md'), 'Target')
  assert.equal(await read('refs.md'), '[Target](target.md)')
})

test('missing backup members stop restoration before any existing file is overwritten', async () => {
  await seed({ 'MEMORY.md': '- [Target](target.md)', 'target.md': 'Target', 'refs.md': '[Target](target.md)' })
  assert.equal((await remove()).ok, true)
  const b = await backup()
  await disk.unlink(join(backupRoot, b.id, 'MEMORY.md'))
  assert.equal((await restoreMemoryBackup(project, b.id, [], backupRoot)).error.code, 'restore-failed')
  await assert.rejects(() => disk.stat(join(dir, 'target.md')), { code: 'ENOENT' })
})

test('memory deletion never follows a junction into another folder', async () => {
  const other = join(home, 'other')
  await put(join(other, 'MEMORY.md'), '- [Target](target.md)')
  await put(join(other, 'target.md'), 'Other folder memory')
  await disk.mkdir(dirname(dir), { recursive: true })
  await disk.symlink(other, dir, 'junction')
  assert.equal((await remove()).ok, false)
  assert.equal(await disk.readFile(join(other, 'target.md'), 'utf8'), 'Other folder memory')
})

test('memory restoration never follows a replacement junction even after overwrite confirmation', async () => {
  await seed({ 'MEMORY.md': '- [Target](target.md)', 'target.md': 'Target' })
  assert.equal((await remove()).ok, true)
  const b = await backup()
  await disk.rename(dir, join(home, 'old-memory'))
  const other = join(home, 'other')
  await put(join(other, 'MEMORY.md'), 'Other index')
  await disk.symlink(other, dir, 'junction')
  assert.equal((await restoreMemoryBackup(project, b.id, b.files, backupRoot)).ok, false)
  assert.equal(await disk.readFile(join(other, 'MEMORY.md'), 'utf8'), 'Other index')
  await assert.rejects(() => disk.stat(join(other, 'target.md')), { code: 'ENOENT' })
})

test('memory backups remain distinct when two deletions share a timestamp', async () => {
  await seed({ 'MEMORY.md': '- [A](a.md)\n- [B](b.md)', 'a.md': 'Memory A', 'b.md': 'Memory B' })
  const RealDate = globalThis.Date
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-01-01T00:00:00Z'])) }
    static now() { return RealDate.parse('2026-01-01T00:00:00Z') }
  }
  try {
    assert.equal((await remove('a.md')).ok, true)
    assert.equal((await remove('b.md')).ok, true)
  } finally {
    globalThis.Date = RealDate
  }
  const backups = await listMemoryBackups(project, backupRoot)
  assert.equal(backups.length, 2)
  assert.notEqual(backups[0].id, backups[1].id)
  for (const b of backups) {
    const letter = b.deletedLabel.toLowerCase()
    assert.equal(await disk.readFile(join(backupRoot, b.id, letter + '.md'), 'utf8'), letter === 'a' ? 'Memory A' : 'Memory B')
  }
})
