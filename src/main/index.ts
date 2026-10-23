import { app, BrowserWindow, ipcMain, nativeTheme, shell, screen, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { DELETED_NOTES } from '../shared/types'
import type { DeleteKind, DeleteTarget, DocFile, LiveSessions, ProjectSummary, SaveMarkdownResult, UiState } from '../shared/types'
import { LIVE_SESSIONS_DIR, liveSessionIds, liveSessions, openInTerminal, planDelete, renameSession, runDelete } from './manage'
import { getProjectMemory, listMemoryBackups, planMemoryDelete, restoreMemoryBackup, runMemoryDelete } from './memory'
import { SearchIndex } from './search'
import { findSession, loadAgent, loadSession, PROJECTS_DIR, SessionIndex } from './sessions'
import { Store } from './store'

const TITLEBAR_HEIGHT = 40
const MARKDOWN_EXT = new Set(['.md', '.mdx', '.markdown'])
const MAX_DOC_BYTES = 8 * 1024 * 1024

// bg must match --bg in styles.css (window background before the page paints).
const theme = (): { bg: string; symbol: string } =>
  nativeTheme.shouldUseDarkColors ? { bg: '#262624', symbol: '#c3c0b6' } : { bg: '#faf9f5', symbol: '#3d3d3a' }

/**
 * The window controls are drawn by Windows over the page. A transparent overlay lets the page show through, so
 * modal backdrops dim the area under them too; re-coloring the overlay instead makes the controls flash.
 */
const OVERLAY_COLOR = '#00000000'

/** Window controls follow the theme and the zoom level (the HTML title bar scales with zoom). */
function applyTitleBarOverlay(): void {
  if (!win) return
  win.setTitleBarOverlay({
    color: OVERLAY_COLOR,
    symbolColor: theme().symbol,
    height: Math.round(TITLEBAR_HEIGHT * win.webContents.getZoomFactor()),
  })
}

const ZOOM_MIN = -3
const ZOOM_MAX = 4

function setZoom(level: number): void {
  if (!win) return
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level))
  win.webContents.setZoomLevel(z)
  store.setZoom(z)
  applyTitleBarOverlay()
}

let win: BrowserWindow | null = null
let store: Store
let index: SessionIndex
const searchIndex = new SearchIndex()
let lastProjects: ProjectSummary[] = []
let watcher: FSWatcher | null = null
let liveWatcher: FSWatcher | null = null
let liveInterval: NodeJS.Timeout | null = null

function projectByKey(key: string): ProjectSummary | undefined {
  return lastProjects.find((p) => p.key === key)
}

function boundsVisible(b: { x?: number; y?: number; width: number; height: number }): boolean {
  if (b.x === undefined || b.y === undefined) return false
  return screen.getAllDisplays().some(({ workArea: a }) => {
    return b.x! < a.x + a.width - 100 && b.x! + b.width > a.x + 100 && b.y! >= a.y - 10 && b.y! < a.y + a.height - 100
  })
}

function createWindow(): void {
  const saved = store.data.window
  const t = theme()
  win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    ...(saved && boundsVisible(saved) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 860,
    minHeight: 520,
    show: false,
    backgroundColor: t.bg,
    title: 'CC History Manager',
    icon: join(__dirname, '../../build/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: OVERLAY_COLOR, symbolColor: t.symbol, height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  })
  if (saved?.maximized) win.maximize()

  win.once('ready-to-show', () => win?.show())

  const saveBounds = (): void => {
    if (!win || win.isMinimized()) return
    const maximized = win.isMaximized()
    const b = maximized ? (store.data.window ?? win.getNormalBounds()) : win.getBounds()
    store.setWindow({ x: b.x, y: b.y, width: b.width, height: b.height, maximized })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('closed', () => {
    win = null
  })

  // Links inside messages open in the system browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.on('found-in-page', (_e, r) => {
    win?.webContents.send('find:result', { active: r.activeMatchOrdinal, total: r.matches })
  })

  // Electron's built-in zoom-in accelerator is Ctrl+Shift+=, so plain Ctrl+= did nothing. Handle zoom here.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
    const current = win?.webContents.getZoomLevel() ?? 0
    if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') setZoom(current + 0.5)
    else if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') setZoom(current - 0.5)
    else if (input.key === '0' || input.code === 'Numpad0') setZoom(0)
    else return
    e.preventDefault()
  })
  win.webContents.on('did-finish-load', () => setZoom(store.data.zoom ?? 0))

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function startWatching(): void {
  let timer: NodeJS.Timeout | null = null
  let agentTimer: NodeJS.Timeout | null = null
  const agentSessions = new Set<string>()
  try {
    watcher = watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
      const name = String(filename ?? '')
      // <dir>\<session>\subagents\agent-*: progress of a subagent, shown in its parent session only.
      const agent = /^[^\\/]+[\\/]([^\\/]+)[\\/]subagents[\\/]agent-[^\\/]+$/.exec(name)
      if (agent) {
        agentSessions.add(agent[1])
        if (agentTimer) clearTimeout(agentTimer)
        agentTimer = setTimeout(() => {
          agentTimer = null
          for (const id of agentSessions) win?.webContents.send('session:agentsChanged', id)
          agentSessions.clear()
        }, 800)
        return
      }
      if (filename && !/^[^\\/]+[\\/][^\\/]+\.jsonl$/.test(name)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        win?.webContents.send('projects:changed')
      }, 1500)
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
    })
  } catch {
    /* projects dir missing: nothing to watch */
  }
}

/** Last pushed live state, so the renderer only hears about real changes (status files are rewritten often). */
let liveJson = '{}'

function serializeLive(live: LiveSessions): string {
  return JSON.stringify(live, Object.keys(live).sort())
}

async function pushLiveIfChanged(): Promise<void> {
  const live = await liveSessions()
  const json = serializeLive(live)
  if (json === liveJson) return
  liveJson = json
  win?.webContents.send('live:changed', live)
}

function startLiveWatching(): void {
  let timer: NodeJS.Timeout | null = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void pushLiveIfChanged()
    }, 500)
  }
  try {
    liveWatcher = watch(LIVE_SESSIONS_DIR, schedule)
    liveWatcher.on('error', () => {
      liveWatcher?.close()
      liveWatcher = null
    })
  } catch {
    /* no Claude Code process has run yet */
  }
  // A crashed or force-closed process leaves its status file behind; only the pid check notices it is gone.
  liveInterval = setInterval(schedule, 15_000)
}

const memoryBackupRoot = () => join(app.getPath('userData'), 'memory-backups')
const deletedNote = () => DELETED_NOTES[store.getUi(app.getLocale()).language ?? 'en']

function registerIpc(): void {
  ipcMain.handle('projects:list', async () => {
    lastProjects = await index.scan()
    void searchIndex.update(lastProjects)
    return lastProjects
  })
  ipcMain.handle('session:load', async (_e, projectKey: string, id: string) => {
    const hit = findSession(lastProjects, projectKey, id)
    return hit ? loadSession(hit.project, hit.family, hit.version) : null
  })
  ipcMain.handle('session:loadAgent', async (_e, projectKey: string, fileId: string, agentId: string) => {
    const hit = findSession(lastProjects, projectKey, fileId)
    return hit ? loadAgent(hit.version, agentId) : null
  })
  ipcMain.handle('sessions:search', (_e, query: string, temp: boolean) => searchIndex.search(lastProjects, query, temp))
  ipcMain.handle('session:rename', (_e, projectKey: string, id: string, title: string) =>
    renameSession(lastProjects, projectKey, id, title),
  )
  ipcMain.handle('memory:get', async (_e, projectKey: string) => {
    const project = projectByKey(projectKey)
    return project ? getProjectMemory(project) : { dir: null, index: null, files: [], missing: [] }
  })
  ipcMain.handle('memory:planDelete', async (_e, projectKey: string, file: string) => {
    const project = projectByKey(projectKey)
    return project ? planMemoryDelete(project, file, await liveSessionIds(), deletedNote()) : null
  })
  ipcMain.handle('memory:runDelete', async (_e, projectKey: string, file: string) => {
    const project = projectByKey(projectKey)
    if (!project) return { ok: false, error: { code: 'project-missing' } }
    return runMemoryDelete(project, file, await liveSessionIds(), memoryBackupRoot(), deletedNote())
  })
  ipcMain.handle('shell:openRecycleBin', () => {
    spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' }).unref()
  })
  ipcMain.handle('memory:listBackups', async (_e, projectKey: string) => {
    const project = projectByKey(projectKey)
    return project ? listMemoryBackups(project, memoryBackupRoot()) : []
  })
  ipcMain.handle('memory:restoreBackup', async (_e, projectKey: string, id: string, overwrite: string[]) => {
    const project = projectByKey(projectKey)
    return project ? restoreMemoryBackup(project, id, overwrite, memoryBackupRoot()) : { ok: false, error: { code: 'project-missing' } }
  })
  ipcMain.handle('shell:openMemoryBackups', async () => {
    const dir = memoryBackupRoot()
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
  ipcMain.handle('session:openTerminal', (_e, projectKey: string, id: string) =>
    openInTerminal(lastProjects, projectKey, id),
  )
  ipcMain.handle('delete:plan', (_e, target: DeleteTarget) => planDelete(lastProjects, target))
  ipcMain.handle('delete:run', (_e, target: DeleteTarget, kinds: DeleteKind[]) => runDelete(lastProjects, target, kinds))
  ipcMain.handle('live:get', async () => {
    const live = await liveSessions()
    liveJson = serializeLive(live)
    return live
  })
  ipcMain.handle('markdown:save', async (_e, defaultName: string, content: string): Promise<SaveMarkdownResult> => {
    if (!win || typeof defaultName !== 'string' || typeof content !== 'string') {
      return { ok: false, error: { code: 'export-failed' } }
    }
    try {
      const name = defaultName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'conversation.md'
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: join(app.getPath('downloads'), name),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      await writeFile(filePath, content, 'utf8')
      return { ok: true }
    } catch {
      return { ok: false, error: { code: 'export-failed' } }
    }
  })
  ipcMain.handle('ui:get', () => store.getUi(app.getLocale()))
  ipcMain.handle('ui:set', (_e, patch: Partial<UiState>) => store.setUi(patch))
  ipcMain.handle('shell:openPath', async (_e, p: string) => {
    await shell.openPath(p)
  })
  ipcMain.handle('shell:showInFolder', (_e, p: string) => shell.showItemInFolder(p))
  // Current content of a Markdown file Claude edited; only Markdown files, the only edits the viewer shows.
  ipcMain.handle('doc:read', async (_e, path: string, base: string): Promise<DocFile | null> => {
    const full = resolve(base, path)
    if (!MARKDOWN_EXT.has(extname(full).toLowerCase())) return null
    try {
      if ((await stat(full)).size > MAX_DOC_BYTES) return null
      return { path: full, content: await readFile(full, 'utf8') }
    } catch {
      return null
    }
  })
  ipcMain.on('find:start', (_e, text: string, forward: boolean, findNext: boolean) => {
    if (text) win?.webContents.findInPage(text, { forward, findNext })
  })
  ipcMain.on('find:stop', () => win?.webContents.stopFindInPage('clearSelection'))
}

// Where settings, the index cache and Chromium caches live. Must be set before the single-instance lock and
// `ready`, which both fix the userData location.
// - `--data-dir=<path>`: a relative path resolves against the exe's folder, not the working directory, so a
//   shortcut keeps working after the whole folder is moved (Windows re-targets a moved shortcut's exe but
//   leaves its arguments unchanged).
// - Otherwise a packaged build is portable and keeps `data\` beside the exe, or uses %APPDATA% when that
//   folder is not writable. Dev runs keep Electron's default.
const exeDir = dirname(process.execPath)
const dataDirArg = process.argv.find((a) => a.startsWith('--data-dir='))?.slice('--data-dir='.length)
let staleDataDir: string | undefined
if (dataDirArg) {
  const dir = resolve(exeDir, dataDirArg)
  // Electron creates userData with all missing parents, which would silently recreate a moved folder tree.
  if (existsSync(dirname(dir))) app.setPath('userData', dir)
  else staleDataDir = dir
} else if (app.isPackaged) {
  const dir = join(exeDir, 'data')
  try {
    mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
  } catch {
    // Read-only install location: keep the %APPDATA% default.
  }
}

if (staleDataDir) {
  // No window or locale yet, so the message is bilingual.
  dialog.showErrorBox(
    'CC History Manager',
    `数据目录的上级文件夹不存在，请检查快捷方式里的 --data-dir 参数。\n` +
      `The parent folder of the data folder doesn't exist. Check the --data-dir argument in the shortcut.\n\n${staleDataDir}`,
  )
  app.exit(1)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('io.github.cigenb.cc-history-manager')
    const userData = app.getPath('userData')
    store = new Store(join(userData, 'state.json'))
    index = new SessionIndex(join(userData, 'index-cache.json'))
    registerIpc()
    createWindow()
    startWatching()
    startLiveWatching()

    nativeTheme.on('updated', () => {
      applyTitleBarOverlay()
      win?.setBackgroundColor(theme().bg)
    })
  })

  app.on('before-quit', () => {
    watcher?.close()
    liveWatcher?.close()
    if (liveInterval) clearInterval(liveInterval)
    store?.flush()
  })
  app.on('window-all-closed', () => app.quit())
}
