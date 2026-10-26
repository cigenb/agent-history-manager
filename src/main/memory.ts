import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type {
  ActionResult,
  MemoryDeletePlan,
  MemoryFile,
  MemoryFileChange,
  MemoryBackup,
  MemoryLineChange,
  ProjectMemory,
  ProjectSummary,
} from '../shared/types'
import { projectMemoryDir, SAFE_SEGMENT } from './sessions'

const INDEX_FILE = 'MEMORY.md'

async function linkedMemoryPath(dir: string, files: string[]): Promise<string | null> {
  for (const path of [dirname(dir), dir, ...files.map((f) => join(dir, f))]) {
    try {
      if ((await fs.lstat(path)).isSymbolicLink()) return path
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  return null
}

/** Mask code while preserving offsets, so examples are not treated as references. */
function visibleMarkdown(text: string): string {
  let fence: { char: string; length: number } | null = null
  return text.split(/(\r?\n)/).map((line, i) => {
    if (i % 2) return line
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      return ' '.repeat(line.length)
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length }
      return ' '.repeat(line.length)
    }
    return line.replace(/(?<!`)(`+)(?!`)(.*?)\1(?!`)/g, (m) => ' '.repeat(m.length))
  }).join('')
}

function unquote(v: string): string {
  const s = v.trim()
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  return s
}

/**
 * Reads the small YAML subset memory files use: top-level `key: value` pairs plus one nested `metadata:`
 * block. Anything else is ignored rather than failing the whole file.
 */
function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  let section = ''
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\s*)([\w.-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, indent, key, value] = kv
    if (!indent) {
      section = value.trim() === '' ? key : ''
      if (value.trim() !== '') fields[key] = unquote(value)
    } else if (section) {
      fields[`${section}.${key}`] = unquote(value)
    }
  }
  return { fields, body: text.slice(m[0].length) }
}

/** `[Title](file.md)` links in MEMORY.md, keyed by lower-cased file name */
function indexLinks(index: string): Map<string, string> {
  const links = new Map<string, string>()
  for (const m of visibleMarkdown(index).matchAll(/(?<!!)\[([^\]\r\n]+)\]\(((?:\.[\\/])?[^\\/:)\r\n]+\.md)(?:#[^)\s]*)?\)/gi)) {
    if (index.slice(0, m.index).endsWith('~~')) continue
    const file = basename(m[2].replace(/\\/g, '/')).toLowerCase()
    if (!links.has(file)) links.set(file, m[1].trim())
  }
  return links
}

export async function getProjectMemory(project: ProjectSummary): Promise<ProjectMemory> {
  const dir = projectMemoryDir(project.path)
  const st = await fs.stat(dir).catch(() => null)
  if (!st?.isDirectory()) return { dir: null, index: null, files: [], missing: [] }

  let names: string[] = []
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
  } catch {
    return { dir, index: null, files: [], missing: [] }
  }

  const indexName = names.find((n) => n.toLowerCase() === INDEX_FILE.toLowerCase())
  const index = indexName ? await fs.readFile(join(dir, indexName), 'utf8').catch(() => null) : null
  const links = index ? indexLinks(index) : new Map<string, string>()

  const files: MemoryFile[] = []
  for (const file of names) {
    if (file === indexName) continue
    const path = join(dir, file)
    const text = await fs.readFile(path, 'utf8').catch(() => null)
    if (text === null) continue
    const { fields, body } = parseFrontmatter(text)
    files.push({
      file,
      path,
      name: fields.name || file.replace(/\.md$/i, ''),
      title: links.get(file.toLowerCase()),
      description: fields.description ?? '',
      type: fields['metadata.type'] || fields.type || '',
      modified: fields['metadata.modified'] || undefined,
      originSessionId: fields['metadata.originSessionId'] || undefined,
      body,
      indexed: links.has(file.toLowerCase()),
    })
  }

  const present = new Set(files.map((f) => f.file.toLowerCase()))
  const missing = [...links.keys()].filter((f) => !present.has(f))
  return { dir, index, files, missing }
}

// ---- deleting a memory --------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Links to the target: `[text](file.md)` (optionally `./`) and `[[name]]` / `[[name|alias]]`. */
function targetLinkRe(target: MemoryFile, aliases: string[]): RegExp {
  const file = escapeRe(target.file)
  const names = [...new Set(aliases)].map(escapeRe).join('|')
  return new RegExp(`(?<!!)\\[[^\\]]*\\]\\((?:\\.[\\\\/])?${file}(?:#[^)\\s]*)?\\)|\\[\\[\\s*(?:${names})\\s*(?:\\|[^\\]]*)?\\]\\]`, 'gi')
}

const ANY_LINK = /!?\[[^\]]*\]\([^)]+\)|\[\[[^\]]+\]\]/g

/**
 * Rewrites one file's links to the target. In the index, a list line whose only memory link is the target is
 * removed; everywhere else the link is struck through and marked, leaving the sentence intact. Links already
 * struck through are left alone, so running this twice changes nothing.
 */
function rewriteLinks(text: string, target: MemoryFile, aliases: string[], isIndex: boolean, note: string): { text: string; lines: MemoryLineChange[] } {
  const parts = text.split(/(\r?\n)/) // even indexes are lines, odd ones the line breaks
  const visible = visibleMarkdown(text).split(/(\r?\n)/)
  const changes: MemoryLineChange[] = []
  const drop = new Set<number>()
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    const hits = [...visible[i].matchAll(targetLinkRe(target, aliases))].filter((m) => !line.slice(0, m.index).endsWith('~~'))
    if (hits.length === 0) continue
    const total = visible[i].match(ANY_LINK)?.length ?? 0
    if (isIndex && /^\s*[-*+]\s/.test(line) && total === hits.length) {
      changes.push({ before: line, after: null })
      drop.add(i)
      // Remove the line together with one adjacent line break.
      drop.add(i + 1 < parts.length ? i + 1 : i - 1)
      continue
    }
    let after = line
    for (const m of hits.reverse()) after = after.slice(0, m.index) + `~~${m[0]}~~${note}` + after.slice(m.index + m[0].length)
    changes.push({ before: line, after })
    parts[i] = after
  }
  return { text: parts.filter((_, i) => !drop.has(i)).join(''), lines: changes }
}

interface PreparedDelete {
  plan: MemoryDeletePlan
  targetPath: string
  writes: { path: string; text: string }[]
}

async function prepareDelete(project: ProjectSummary, file: string, live: Set<string>, note: string): Promise<PreparedDelete | null> {
  const memory = await getProjectMemory(project)
  const target = memory.files.find((f) => f.file.toLowerCase() === file.toLowerCase())
  if (!memory.dir || !target) return null

  const changes: MemoryFileChange[] = []
  const writes: { path: string; text: string }[] = []
  const aliases = [target.file.replace(/\.md$/i, '')]
  const name = target.name.toLowerCase()
  if (!memory.files.some((f) => f !== target && (f.name.toLowerCase() === name || f.file.replace(/\.md$/i, '').toLowerCase() === name))) aliases.push(target.name)
  const candidates = (await fs.readdir(memory.dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.md$/i.test(e.name) && e.name.toLowerCase() !== target.file.toLowerCase())
  for (const c of candidates) {
    const path = join(memory.dir, c.name)
    const raw = await fs.readFile(path, 'utf8')
    const isIndex = c.name.toLowerCase() === INDEX_FILE.toLowerCase()
    const file = memory.files.find((f) => f.file === c.name)
    const r = rewriteLinks(raw, target, aliases, isIndex, note)
    if (r.lines.length === 0) continue
    changes.push({ file: c.name, label: isIndex ? INDEX_FILE : file?.title || file?.name || c.name, lines: r.lines })
    writes.push({ path, text: r.text })
  }

  const projectLive = project.sessions.some((s) => s.versions.some((v) => live.has(v.id)))
  return {
    plan: {
      target: { file: target.file, label: target.title || target.name, description: target.description },
      changes,
      projectLive,
    },
    targetPath: target.path,
    writes,
  }
}

export async function planMemoryDelete(
  project: ProjectSummary,
  file: string,
  live: Set<string>,
  note: string,
): Promise<MemoryDeletePlan | null> {
  return (await prepareDelete(project, file, live, note))?.plan ?? null
}

// ---- backups ------------------------------------------------------------------

/**
 * One deletion's backup: `<backupRoot>/<id>/` holds the deleted memory file, the original versions of every
 * file the deletion rewrote, and this manifest.
 */
interface BackupManifest {
  version: 1
  time: string
  memoryDir: string
  deleted: { file: string; label: string }
  /** Files rewritten by the deletion, with their mtime right after; a later mtime means someone edited them since */
  rewritten: { file: string; mtimeMs: number | null }[]
}

const MANIFEST = 'manifest.json'
const BACKUP_ID = /^[\w-]+$/

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await fs.copyFile(from, to)
    await fs.unlink(from)
  }
}

/**
 * Saves originals of the files it will rewrite, moves the memory file itself into the same backup (it is not
 * sent to the Recycle Bin; restoring happens from the backup), then writes the rewritten files. The plan is
 * recomputed here from the files as they are now, not taken from the renderer.
 */
export async function runMemoryDelete(
  project: ProjectSummary,
  file: string,
  live: Set<string>,
  backupRoot: string,
  note: string,
): Promise<ActionResult> {
  let prep: PreparedDelete | null
  try {
    prep = await prepareDelete(project, file, live, note)
    if (prep) {
      const linked = await linkedMemoryPath(dirname(prep.targetPath), [basename(prep.targetPath), ...prep.writes.map((w) => basename(w.path))])
      if (linked) return { ok: false, error: { code: 'memory-linked-path', path: linked } }
    }
  } catch (e) {
    return { ok: false, error: { code: 'backup-failed', detail: (e as Error).message } }
  }
  if (!prep) return { ok: false, error: { code: 'memory-missing' } }
  let backupDir: string
  try {
    await fs.mkdir(backupRoot, { recursive: true })
    backupDir = await fs.mkdtemp(join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-'))
  } catch (e) {
    return { ok: false, error: { code: 'backup-failed', detail: (e as Error).message } }
  }
  const manifest: BackupManifest = {
    version: 1,
    time: new Date().toISOString(),
    memoryDir: dirname(prep.targetPath),
    deleted: { file: basename(prep.targetPath), label: prep.plan.target.label },
    rewritten: prep.writes.map((w) => ({ file: basename(w.path), mtimeMs: null })),
  }
  const writeManifest = () => fs.writeFile(join(backupDir, MANIFEST), JSON.stringify(manifest, null, 2))
  try {
    for (const w of prep.writes) await fs.copyFile(w.path, join(backupDir, basename(w.path)))
    await writeManifest()
    await moveFile(prep.targetPath, join(backupDir, basename(prep.targetPath)))
  } catch (e) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: { code: 'backup-failed', detail: (e as Error).message } }
  }

  const failed: string[] = []
  for (const [i, w] of prep.writes.entries()) {
    try {
      await fs.writeFile(w.path, w.text)
      manifest.rewritten[i].mtimeMs = (await fs.stat(w.path)).mtimeMs
    } catch {
      failed.push(basename(w.path))
    }
  }
  await writeManifest().catch(() => undefined)
  return failed.length ? { ok: false, error: { code: 'memory-update-failed', files: failed } } : { ok: true }
}

async function readManifest(backupRoot: string, id: string): Promise<BackupManifest | null> {
  if (!BACKUP_ID.test(id)) return null
  try {
    if (!(await fs.lstat(join(backupRoot, id))).isDirectory() || !(await fs.lstat(join(backupRoot, id, MANIFEST))).isFile()) return null
    const m = JSON.parse(await fs.readFile(join(backupRoot, id, MANIFEST), 'utf8')) as BackupManifest
    const files = [m.deleted.file, ...m.rewritten.map((r) => r.file)]
    return m.version === 1 && typeof m.memoryDir === 'string' && typeof m.time === 'string' &&
      files.every((f) => typeof f === 'string' && SAFE_SEGMENT.test(f) && /\.md$/i.test(f)) && m.deleted.file.toLowerCase() !== INDEX_FILE.toLowerCase() ? m : null
  } catch {
    return null
  }
}

/** Files that changed after the deletion and would be overwritten by restoring it. */
async function changedSince(m: BackupManifest): Promise<string[]> {
  const changed: string[] = []
  for (const r of m.rewritten) {
    const st = await fs.stat(join(m.memoryDir, r.file)).catch(() => null)
    if (r.mtimeMs === null || !st || st.mtimeMs !== r.mtimeMs) changed.push(r.file)
  }
  if (await fs.stat(join(m.memoryDir, m.deleted.file)).catch(() => null)) changed.push(m.deleted.file)
  return changed
}

/** Deletions of this project's memories that can be restored, newest first. */
export async function listMemoryBackups(project: ProjectSummary, backupRoot: string): Promise<MemoryBackup[]> {
  const dir = projectMemoryDir(project.path)
  let ids: string[] = []
  try {
    ids = await fs.readdir(backupRoot)
  } catch {
    return []
  }
  const out: MemoryBackup[] = []
  for (const id of ids) {
    const m = await readManifest(backupRoot, id)
    if (!m || m.memoryDir.toLowerCase() !== dir.toLowerCase()) continue
    out.push({
      id,
      time: m.time,
      deletedLabel: m.deleted.label,
      files: [m.deleted.file, ...m.rewritten.map((r) => r.file)],
      changed: await changedSince(m),
    })
  }
  return out.sort((a, b) => b.time.localeCompare(a.time))
}

/** Puts every file of a backup back into the memory folder, then removes the backup. */
export async function restoreMemoryBackup(
  project: ProjectSummary,
  id: string,
  overwrite: string[],
  backupRoot: string,
): Promise<ActionResult> {
  const m = await readManifest(backupRoot, id)
  const dir = projectMemoryDir(project.path)
  if (!m || m.memoryDir.toLowerCase() !== dir.toLowerCase()) return { ok: false, error: { code: 'backup-missing' } }
  const backupDir = join(backupRoot, id)
  const files = [m.deleted.file, ...m.rewritten.map((r) => r.file)]
  try {
    const linked = await linkedMemoryPath(dir, files)
    if (linked) return { ok: false, error: { code: 'memory-linked-path', path: linked } }
  } catch (e) {
    return { ok: false, error: { code: 'restore-failed', detail: (e as Error).message, path: backupDir } }
  }
  const allowed = new Set(overwrite.map((f) => f.toLowerCase()))
  const changed = (await changedSince(m)).filter((f) => !allowed.has(f.toLowerCase()))
  if (changed.length) return { ok: false, error: { code: 'backup-changed', files: changed } }
  try {
    for (const f of files) {
      const st = await fs.lstat(join(backupDir, f))
      if (!st.isFile()) return { ok: false, error: { code: 'restore-failed', detail: f, path: backupDir } }
    }
    await fs.mkdir(dir, { recursive: true })
    for (const f of files) {
      await fs.copyFile(join(backupDir, f), join(dir, f))
    }
  } catch (e) {
    return { ok: false, error: { code: 'restore-failed', detail: (e as Error).message, path: backupDir } }
  }
  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
  return { ok: true }
}
