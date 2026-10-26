/** Claude Code conversations live in ~/.claude/projects, Codex threads in ~/.codex, Grok conversations in ~/.grok/sessions. */
export type SessionSource = 'claude' | 'codex' | 'grok'

/** One session file. */
export interface SessionVersion {
  id: string
  /** Claude: folder under ~/.claude/projects holding `<id>.jsonl`. Grok: folder under ~/.grok/sessions holding `<id>/` */
  dir: string
  title: string
  /** Epoch ms of the last user/assistant record */
  lastActivity: number
  promptCount: number
}

/**
 * One conversation as shown in the list. Claude Desktop copies the history into a new file when a conversation is
 * resumed, rewound or forked, so a conversation can span several files (`versions`, newest first). The fields
 * inherited from SessionVersion describe the primary file: the one with the most prompts.
 */
export interface SessionSummary extends SessionVersion {
  projectKey: string
  /** Latest activity across all versions; used for ordering */
  familyActivity: number
  /** Started by `claude -p` / `grok -p` (scripts, hooks, tests) rather than by a person */
  headless: boolean
  versions: SessionVersion[]
  /** Codex threads archived in Codex Desktop */
  archived?: boolean
}

export interface ProjectSummary {
  source: SessionSource
  /** Lower-cased start directory; sessions from several ~/.claude/projects folders can share it. Grok keys start with `grok:` */
  key: string
  /** Directory the sessions were started in (first record's `cwd`) */
  path: string
  name: string
  /** Codex Desktop's group of threads started without a project; it has no path */
  projectless?: boolean
  isTemp: boolean
  lastActivity: number
  /** Memory files in the project's memory folder (MEMORY.md not counted) */
  memoryCount: number
  sessions: SessionSummary[]
}

export interface ImageData {
  mediaType: string
  data: string
}

/**
 * A Markdown edit made through the Edit / MultiEdit / Write tools. Each hunk is an old → new replacement;
 * Write records only the new content, so its single hunk has an empty `old`.
 */
export interface DocEdit {
  path: string
  kind: 'edit' | 'write'
  hunks: { old: string; new: string }[]
}

/** A subagent started with the Agent tool. */
export interface AgentRun {
  /** Transcript `subagents/agent-<id>.jsonl`; null when it is missing */
  id: string | null
  description: string
  /** subagent_type, e.g. general-purpose */
  type: string
  model?: string
  /** done: its last reply ended its turn; stopped: stopped by the user; open: still working, or cut off */
  state: 'done' | 'stopped' | 'open'
  toolCalls: number
}

/** Calls to one MCP tool within an answer. */
export interface McpUse {
  server: string
  tool: string
  count: number
  /** open: a call has no result yet (still running, or cut off) */
  state: 'done' | 'error' | 'open'
}

export type Turn =
  | { kind: 'user'; text: string; images: ImageData[]; time: number }
  | {
      kind: 'assistant'
      /** Final answer: the text after the turn's last tool call */
      text: string
      /** Commentary written between tool calls earlier in the turn, oldest first */
      steps: string[]
      /** Successful Markdown file edits made during the turn */
      edits: DocEdit[]
      agents: AgentRun[]
      mcp: McpUse[]
      time: number
    }
  | { kind: 'command'; text: string; time: number }
  | { kind: 'compact'; time: number }
  /**
   * Claude continuing without a new prompt after ending its turn. `agent` is the description of the subagent
   * whose report woke it; `message` is a message from another session.
   */
  | { kind: 'resume'; source: 'agent' | 'message' | 'notification' | 'other'; agent?: string; time: number }

/** A Markdown file as it is on disk now. */
export interface DocFile {
  /** Absolute path */
  path: string
  content: string
}

export interface AgentDetail {
  run: AgentRun
  turns: Turn[]
}

export interface SessionDetail {
  source: SessionSource
  /** File currently shown */
  id: string
  /** Primary file id of the conversation (SessionSummary.id) */
  familyId: string
  projectKey: string
  versions: SessionVersion[]
  path: string
  turns: Turn[]
  firstTime: number
  lastTime: number
}

export type Language = 'zh' | 'en'

export interface UiState {
  language?: Language
  projectOrder: string[]
  expanded: string[]
  /** true: list only temp-folder and scripted sessions; false: list only regular projects */
  showTemp: boolean
  /** Viewer-only conversation order per project key. Entries are any version id of a conversation. */
  sessionOrder: Record<string, string[]>
  /** Which history the sidebar lists */
  source: SessionSource
}

/** What a deletable path is; the delete dialog lets the user pick which kinds to remove. */
export type DeleteKind = 'sessions' | 'artifacts' | 'history' | 'temp' | 'memory' | 'output'

export type DeleteTarget =
  | { kind: 'session'; projectKey: string; id: string }
  | { kind: 'project'; projectKey: string }

export interface DeleteItem {
  path: string
  bytes: number
  kind: DeleteKind
}

export interface DeletePlan {
  /** Everything that can be removed, project memory included; the user picks kinds before running */
  items: DeleteItem[]
  /** Set when deletion must not proceed, e.g. a session is still open in Claude Code */
  blocked?: ActionError
  /**
   * grok: everything is deleted permanently with `grok sessions delete`; kinds cannot be deselected.
   * codex: Codex deletes the threads permanently and Desktop's entries for them are removed; files go to the Recycle Bin.
   */
  mode?: 'grok' | 'codex'
}

/** One memory file from a project's `memory/` folder. */
export interface MemoryFile {
  /** File name, e.g. `example-memory.md` */
  file: string
  path: string
  /** Frontmatter `name`, falling back to the file name without `.md`; this is the memory's id */
  name: string
  /** Link text used for this file in MEMORY.md, if listed there */
  title?: string
  description: string
  /** Frontmatter `metadata.type`: user / feedback / project / reference, or empty */
  type: string
  modified?: string
  /** Session that wrote the memory (`metadata.originSessionId`) */
  originSessionId?: string
  /** Markdown body without the frontmatter */
  body: string
  /** Whether MEMORY.md links to this file */
  indexed: boolean
}

export interface ProjectMemory {
  /** The project's memory folder; null when it does not exist */
  dir: string | null
  /** MEMORY.md content, null when there is no index file */
  index: string | null
  files: MemoryFile[]
  /** Files linked from MEMORY.md that do not exist */
  missing: string[]
}

/**
 * Appended after a struck-through link; tells later readers (and Claude) the removal was intentional.
 * Written in the UI language at deletion time, so a memory folder may contain either note.
 */
export const DELETED_NOTES = { zh: '（已由用户手动删除）', en: ' (deleted by the user)' } as const

/** One line a memory deletion touches in another file. */
export interface MemoryLineChange {
  before: string
  /** null: the line is removed (an index line that only pointed at the deleted memory) */
  after: string | null
}

export interface MemoryFileChange {
  /** File name within the memory folder */
  file: string
  /** Display name: `MEMORY.md` or the memory's title */
  label: string
  lines: MemoryLineChange[]
}

export interface MemoryDeletePlan {
  target: { file: string; label: string; description: string }
  /** Other files whose links to the target get removed or struck through */
  changes: MemoryFileChange[]
  /** A conversation of this project is open in Claude Code and might write MEMORY.md at the same time */
  projectLive: boolean
}

/** A memory deletion that can be undone from its backup. */
export interface MemoryBackup {
  id: string
  /** ISO time of the deletion */
  time: string
  deletedLabel: string
  /** Files the restore puts back: the deleted memory plus the originals of every file it rewrote */
  files: string[]
  /** Files changed after the deletion; restoring overwrites those changes */
  changed: string[]
}

/** Session file id → state, for sessions open in a running Claude Code process */
export type LiveSessions = Record<string, 'idle' | 'busy'>

export type ActionError =
  | { code: 'session-open' | 'session-missing' | 'project-missing' | 'name-empty' | 'memory-missing' | 'backup-missing' | 'export-failed' }
  | { code: 'trash-failed' | 'memory-update-failed' | 'backup-changed'; files: string[] }
  | { code: 'directory-missing'; path: string }
  | { code: 'terminal-failed' | 'rename-failed' | 'backup-failed' | 'grok-failed'; detail: string }
  | { code: 'grok-session-open' | 'codex-running' }
  | { code: 'codex-failed'; detail: string }
  | { code: 'restore-failed'; detail: string; path: string }

export interface ActionResult {
  ok: boolean
  error?: ActionError
}

export interface SaveMarkdownResult extends ActionResult {
  canceled?: boolean
}

/** One message matching a content search. */
export interface SearchHit {
  /** Session file holding the message: the conversation's primary file, unless only another version has a match */
  fileId: string
  /** Text around the first match, whitespace collapsed */
  snippet: string
  /** Exact excerpt around the match, for finding the turn once the session is loaded */
  needle: string
}

export interface SearchResult {
  projectKey: string
  /** Conversation id (its primary file) */
  id: string
  /** Every term appears in the title of one of its versions */
  titleMatch: boolean
  /** Earliest message holding every term; absent when only the title matched */
  hit?: SearchHit
}

export interface SearchResponse {
  /** Title matches first, then by latest activity */
  results: SearchResult[]
  /** More conversations matched than were returned */
  truncated: boolean
}

export interface FindResult {
  active: number
  total: number
}

export interface Api {
  listProjects(): Promise<ProjectSummary[]>
  /** `id` may be the conversation's primary id or any of its version ids */
  loadSession(projectKey: string, id: string): Promise<SessionDetail | null>
  /** `fileId`: the session file that started the subagent (SessionDetail.id) */
  loadAgent(projectKey: string, fileId: string, agentId: string): Promise<AgentDetail | null>
  saveMarkdown(defaultName: string, content: string): Promise<SaveMarkdownResult>
  getUiState(): Promise<UiState>
  setUiState(patch: Partial<UiState>): Promise<void>
  openPath(path: string): Promise<void>
  /** File Explorer with the file selected */
  showInFolder(path: string): Promise<void>
  /** A Markdown file's current content; a relative `path` resolves against `base`. Null when unreadable */
  readMarkdown(path: string, base: string): Promise<DocFile | null>
  /** Windows Recycle Bin, where deleted sessions and memories go */
  openRecycleBin(): Promise<void>
  /** Folder holding copies of files rewritten when a memory was deleted */
  openMemoryBackups(): Promise<void>
  /** Same effect as /rename: the new title also shows in Claude Code's /resume list */
  renameSession(projectKey: string, id: string, title: string): Promise<ActionResult>
  /** Read-only view of the project's memory folder */
  getProjectMemory(projectKey: string): Promise<ProjectMemory>
  planMemoryDelete(projectKey: string, file: string): Promise<MemoryDeletePlan | null>
  /** Moves the memory file into a backup, with the originals of every file it rewrites, then updates links */
  runMemoryDelete(projectKey: string, file: string): Promise<ActionResult>
  listMemoryBackups(projectKey: string): Promise<MemoryBackup[]>
  restoreMemoryBackup(projectKey: string, id: string, overwrite: string[]): Promise<ActionResult>
  /** New Windows Terminal tab in the project directory running `claude --resume` */
  openInTerminal(projectKey: string, id: string): Promise<ActionResult>
  /** New Windows Terminal tab in the project directory starting a new `claude` conversation */
  openProjectInTerminal(projectKey: string): Promise<ActionResult>
  planDelete(target: DeleteTarget): Promise<DeletePlan>
  /** Moves the planned files of the chosen kinds to the Recycle Bin */
  runDelete(target: DeleteTarget, kinds: DeleteKind[]): Promise<ActionResult>
  /**
   * Conversation titles, prompts and Claude's answer text. Every space-separated term must appear in the title or
   * in one message. `temp` selects temp-folder and scripted conversations, as the sidebar's toggle does.
   */
  searchSessions(query: string, temp: boolean, source: SessionSource): Promise<SearchResponse>
  find(text: string, forward: boolean, findNext: boolean): void
  stopFind(): void
  onFindResult(cb: (r: FindResult) => void): () => void
  onProjectsChanged(cb: () => void): () => void
  /** A subagent transcript of this session file changed */
  onAgentsChanged(cb: (sessionId: string) => void): () => void
  getLiveSessions(): Promise<LiveSessions>
  /** Fires only when the set of open sessions or their busy/idle state changes */
  onLiveSessionsChanged(cb: (live: LiveSessions) => void): () => void
}
