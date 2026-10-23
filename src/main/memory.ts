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
import { projectMemoryDir } from './sessions'

const INDEX_FILE = 'MEMORY.md'

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
  for (const m of index.matchAll(/\[([^\]]+)\]\(([^)\s]+\.md)\)/gi)) {
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
function targetLinkRe(target: MemoryFile): RegExp {
  const file = escapeRe(target.file)
  const names = [...new Set([target.name, target.file.replace(/\.md$/i, '')])].map(escapeRe).join('|')
  return new RegExp(`\\[[^\\]]*\\]\\((?:\\.[\\\\/])?${file}\\)|\\[\\[\\s*(?:${names})\\s*(?:\\|[^\\]]*)?\\]\\]`, 'gi')
}

const ANY_MEMORY_LINK = /\[[^\]]*\]\([^)\s]+\.md\)|\[\[[^\]]+\]\]/gi

/**
 * Rewrites one file's links to the target. In the index, a list line whose only memory link is the target is
 * removed; everywhere else the link is struck through and marked, leaving the sentence intact. Links already
 * struck through are left alone, so running this twice changes nothing.
 */
function rewriteLinks(text: string, target: MemoryFile, isIndex: boolean, note: string): { text: string; lines: MemoryLineChange[] } {
  const parts = text.split(/(\r?\n)/) // even indexes are lines, odd ones the line breaks
  const changes: MemoryLineChange[] = []
  const drop = new Set<number>()
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    const re = targetLinkRe(target)
    const hits = [...line.matchAll(re)].filter((m) => !line.slice(0, m.index).endsWith('~~'))
    if (hits.length === 0) continue
    const total = line.match(ANY_MEMORY_LINK)?.length ?? 0
    if (isIndex && /^\s*[-*+]\s/.test(line) && total === hits.length) {
      changes.push({ before: line, after: null })
      drop.add(i)
      // Remove the line together with one adjacent line break.
      drop.add(i + 1 < parts.length ? i + 1 : i - 1)
      continue
    }
    const after = line.replace(re, (m, offset: number, s: string) =>
      s.slice(0, offset).endsWith('~~') ? m : `~~${m}~~${note}`,
    )
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
  const indexName = (await fs.readdir(memory.dir)).find((n) => n.toLowerCase() === INDEX_FILE.toLowerCase())
  const candidates = [
    ...(indexName ? [{ file: indexName, path: join(memory.dir, indexName), label: INDEX_FILE, isIndex: true }] : []),
    ...memory.files
      .filter((f) => f !== target)
      .map((f) => ({ file: f.file, path: f.path, label: f.title || f.name, isIndex: false })),
  ]
  for (const c of candidates) {
    const raw = await fs.readFile(c.path, 'utf8').catch(() => null)
    if (raw === null) continue
    const r = rewriteLinks(raw, target, c.isIndex, note)
    if (r.lines.length === 0) continue
    changes.push({ file: c.file, label: c.label, lines: r.lines })
    writes.push({ path: c.path, text: r.text })
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
  const prep = await prepareDelete(project, file, live, note)
  if (!prep) return { ok: false, error: { code: 'memory-missing' } }
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(backupRoot, id)
  const manifest: BackupManifest = {
    version: 1,
    time: new Date().toISOString(),
    memoryDir: dirname(prep.targetPath),
    deleted: { file: basename(prep.targetPath), label: prep.plan.target.label },
    rewritten: prep.writes.map((w) => ({ file: basename(w.path), mtimeMs: null })),
  }
  const writeManifest = () => fs.writeFile(join(backupDir, MANIFEST), JSON.stringify(manifest, null, 2))
  try {
    await fs.mkdir(backupDir, { recursive: true })
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
    const m = JSON.parse(await fs.readFile(join(backupRoot, id, MANIFEST), 'utf8')) as BackupManifest
    return m.version === 1 ? m : null
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
  const allowed = new Set(overwrite.map((f) => f.toLowerCase()))
  const changed = (await changedSince(m)).filter((f) => !allowed.has(f.toLowerCase()))
  if (changed.length) return { ok: false, error: { code: 'backup-changed', files: changed } }
  const backupDir = join(backupRoot, id)
  try {
    await fs.mkdir(dir, { recursive: true })
    for (const f of [m.deleted.file, ...m.rewritten.map((r) => r.file)]) {
      await fs.copyFile(join(backupDir, f), join(dir, f))
    }
  } catch (e) {
    return { ok: false, error: { code: 'restore-failed', detail: (e as Error).message, path: backupDir } }
  }
  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
  return { ok: true }
}
