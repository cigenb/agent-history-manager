import { contextBridge, ipcRenderer } from 'electron'
import type { Api, FindResult, LiveSessions } from '../shared/types'

const api: Api = {
  saveMarkdown: (defaultName, content) => ipcRenderer.invoke('markdown:save', defaultName, content),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  loadSession: (projectKey, id) => ipcRenderer.invoke('session:load', projectKey, id),
  loadAgent: (projectKey, fileId, agentId) => ipcRenderer.invoke('session:loadAgent', projectKey, fileId, agentId),
  getUiState: () => ipcRenderer.invoke('ui:get'),
  setUiState: (patch) => ipcRenderer.invoke('ui:set', patch),
  openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
  showInFolder: (path) => ipcRenderer.invoke('shell:showInFolder', path),
  readMarkdown: (path, base) => ipcRenderer.invoke('doc:read', path, base),
  openRecycleBin: () => ipcRenderer.invoke('shell:openRecycleBin'),
  openMemoryBackups: () => ipcRenderer.invoke('shell:openMemoryBackups'),
  renameSession: (projectKey, id, title) => ipcRenderer.invoke('session:rename', projectKey, id, title),
  getProjectMemory: (projectKey) => ipcRenderer.invoke('memory:get', projectKey),
  planMemoryDelete: (projectKey, file) => ipcRenderer.invoke('memory:planDelete', projectKey, file),
  runMemoryDelete: (projectKey, file) => ipcRenderer.invoke('memory:runDelete', projectKey, file),
  listMemoryBackups: (projectKey) => ipcRenderer.invoke('memory:listBackups', projectKey),
  restoreMemoryBackup: (projectKey, id, overwrite) => ipcRenderer.invoke('memory:restoreBackup', projectKey, id, overwrite),
  openInTerminal: (projectKey, id) => ipcRenderer.invoke('session:openTerminal', projectKey, id),
  openProjectInTerminal: (projectKey) => ipcRenderer.invoke('project:openTerminal', projectKey),
  planDelete: (target) => ipcRenderer.invoke('delete:plan', target),
  runDelete: (target, kinds) => ipcRenderer.invoke('delete:run', target, kinds),
  searchSessions: (query, temp, source) => ipcRenderer.invoke('sessions:search', query, temp, source),
  find: (text, forward, findNext) => ipcRenderer.send('find:start', text, forward, findNext),
  stopFind: () => ipcRenderer.send('find:stop'),
  onFindResult: (cb) => {
    const h = (_e: unknown, r: FindResult): void => cb(r)
    ipcRenderer.on('find:result', h)
    return () => ipcRenderer.removeListener('find:result', h)
  },
  onProjectsChanged: (cb) => {
    const h = (): void => cb()
    ipcRenderer.on('projects:changed', h)
    return () => ipcRenderer.removeListener('projects:changed', h)
  },
  onAgentsChanged: (cb) => {
    const h = (_e: unknown, sessionId: string): void => cb(sessionId)
    ipcRenderer.on('session:agentsChanged', h)
    return () => ipcRenderer.removeListener('session:agentsChanged', h)
  },
  getLiveSessions: () => ipcRenderer.invoke('live:get'),
  onLiveSessionsChanged: (cb) => {
    const h = (_e: unknown, live: LiveSessions): void => cb(live)
    ipcRenderer.on('live:changed', h)
    return () => ipcRenderer.removeListener('live:changed', h)
  },
}

contextBridge.exposeInMainWorld('api', api)
