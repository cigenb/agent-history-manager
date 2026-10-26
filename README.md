# Agent History Manager

English | [简体中文](README.zh-CN.md)

A Windows desktop app for the local conversation history of three coding agents: [Claude Code](https://code.claude.com), [Codex](https://openai.com/codex), and [Grok](https://x.ai). It lists conversations by project, shows and searches them, manages Claude Code project memories, and deletes conversations together with the data they leave behind.

It runs entirely on local files. The agents' data is only read, except when you rename or delete something yourself.

![Main window: a conversation with a Markdown edit previewed in the right panel](docs/screenshots/main.png)

## Sources

The switch at the top of the sidebar selects which history is listed.

| | Claude | Codex | Grok |
|---|---|---|---|
| Read from | `~/.claude/projects` | `~/.codex` (thread index, conversation history, Codex Desktop state) | `~/.grok/sessions` |
| Grouped by | Start folder | Codex Desktop projects; projectless chats in one group | Working folder |
| Conversation view | Prompts and replies | Prompts and replies | Prompts and replies |
| Search | Titles and content | Titles and content | Titles and content |
| Open in terminal | `claude --resume <id>` | — | `grok --resume <id>` |
| Delete | To the Recycle Bin | Permanently, through Codex; files to the Recycle Bin | Permanently |
| Project memories | Yes | — | — |

## Delete Claude Code conversations

Each Claude Code conversation leaves files in several places: the transcript, subagent and tool output, file backups for `/rewind`, a temporary workspace, and the project's memories. When you delete a conversation or a project, the app collects all of them and shows them grouped by category, with sizes:

- Expand any category to see every file and folder it contains.
- Uncheck the categories you want to keep.
- Everything checked goes to the Recycle Bin, so it can be restored.

Copies of one conversation (created when a session is resumed, rewound, or forked) are deleted together. Conversations that are currently open in Claude Code cannot be deleted or renamed.

![Delete dialog listing related data by category](docs/screenshots/delete.png)

## Delete Codex conversations

Codex conversations are grouped by Codex Desktop project, with the titles Codex Desktop shows. They are continued in Codex Desktop, not from here. Deleting a conversation or a project removes:

- **Conversation records**: deleted by Codex itself (`thread/delete` of the Codex app-server bundled with Codex Desktop), including the conversation's subagent threads. This is permanent.
- **Codex Desktop cache entries**: Codex Desktop keeps per-conversation entries (descriptions, workspace hints, output folders, sidebar order) in `~/.codex/.codex-global-state.json` and does not remove them for every deleted conversation. The app removes the entries of the deleted conversations from that file and from `session_index.jsonl` and `history.jsonl`. Each changed file is backed up first to `codex-backups` in the app's data folder.
- **Generated images** (`~/.codex/generated_images/<id>`) and the **working folder of a projectless chat** (the folder Codex Desktop created for it, outputs included): moved to the Recycle Bin. A working folder is only removed when no other conversation works in it. The working folder of a conversation in a project is never removed.

Quit Codex Desktop completely before deleting: it keeps its state in memory and writes it back, so deletion is refused while it is running.

**Check Codex leftovers** (see [Leftover check](#leftover-check)) lists what conversations no longer in the list left behind, grouped like the delete dialog: rollout files Codex no longer indexes, Codex Desktop cache entries of deleted conversations, working folders of projectless chats that no conversation uses any more, and generated images of deleted conversations. Expand a category to see each path and open it in File Explorer; uncheck what you want to keep. Only entries with evidence of a deleted local conversation are cleaned. Log rows of conversations that have no rollout file are not touched.

## Grok conversations

Grok's own subagents are listed in the right panel and can be opened.

**Check Grok leftovers** (see [Leftover check](#leftover-check)) lists session folders the list doesn't show: empty sessions without a prompt or a reply, and subagent sessions whose parent was deleted. They go to the Recycle Bin. Top-level sessions with unreadable or incomplete logs are kept.

Deleting a Grok conversation is permanent: it runs `grok sessions delete` for the session and the sessions of its subagents, which may also remove history stored remotely. Subagent session folders the Grok CLI leaves behind go to the Recycle Bin. Sessions open in Grok cannot be deleted or resumed.

## Leftover check

The broom button in the title bar checks the selected history for files the list doesn't account for, and shows them in the same dialog as deletion: grouped by category, each path openable in File Explorer, each category optional. For Claude Code these are sessions without a prompt or a reply, subagent output, `/rewind` backups, session environments and temporary workspaces of sessions that no longer exist, and project folders without sessions; memories found there start unchecked. Everything goes to the Recycle Bin. Codex and Grok are described above.

## Manage Claude Code project memories

Claude Code keeps per-project memories as Markdown files in `~/.claude/projects/<project>/memory/`, indexed by `MEMORY.md`. The memory panel shows them:

- The index, plus every memory grouped by type (user, feedback, project, reference).
- Memories missing from the index, and index links pointing to files that no longer exist.
- A link to the conversation that wrote each memory.
- **Delete**: links to the memory in other memory files are struck through and marked as deleted rather than left broken, so Claude can tell it was removed on purpose.
- **Backups**: every deletion is backed up, with the original versions of every file it changed, and can be restored in one click. If those files changed again afterwards, you are asked before they are overwritten.
- Reference updates match local memory links; links to websites or other folders and code examples are kept. Deletion and restoration do not follow symbolic links or junctions.

![Memory panel](docs/screenshots/memory.png)

## Read conversations next to your terminal

Conversations refresh as the agents write them, and Claude Code conversations that are open are marked. You can keep a small terminal window for typing and read the conversation here:

- Only prompts and replies are shown, with Markdown rendered. Codex attachments are shown as images when the pasted file still exists. Commentary written between tool calls is folded; tool calls, tool output, and thinking are left out. When the agent continues on its own (for example after a subagent reports back), each reply stays separate.
- **Markdown edits** made by Claude Code appear as diff cards. **Preview** opens the file's current content in the right panel with the changed lines highlighted.
- **Subagents and MCP calls** are listed in the right panel with their status. Click a subagent to read its own conversation.
- Claude Code records with commands or replies but no prompt, and Grok records with replies but no prompt, appear under **Temporary & scripted only**, where they can be viewed, searched, and deleted. Indexed Codex conversations remain listed even before their first prompt or reply.
- **Open in terminal** opens a Windows Terminal tab in the project folder: on a conversation it resumes it, on a project it starts a new conversation.

## Search

One search box covers conversation titles and the text of prompts and replies in the selected history. Results open at the matching message with the search terms highlighted.

![Search results and a subagent conversation](docs/screenshots/search-subagent.png)

## What it reads and writes

It writes only when you:

- **Rename** a Claude Code conversation: appends a `custom-title` record to the session file, as `/rename` does.
- **Delete** a Claude Code conversation or project: moves the files you selected to the Recycle Bin.
- **Delete a memory**: moves the file into a backup in the app's own data folder and updates links to it in the other memory files. Restoring puts the files back.
- **Delete** Codex or Grok conversations: as described above.

Its own settings and caches (project order, window size, index caches, Codex backups) stay in its data folder. It does not read login credentials and does not call any model API. The app itself makes no network requests; the `grok` and `codex` commands it runs to delete conversations may contact their services.

## Install

1. Download `Agent-History-Manager-<version>-win-x64.zip` from [Releases](https://github.com/cigenb/agent-history-manager/releases).
2. Extract it anywhere and run `Agent History Manager.exe`.

There is no installer. Settings are stored in a `data` folder next to the exe (or in `%APPDATA%\Agent History Manager` if that folder is not writable). To uninstall, delete the folder.

Requirements: Windows 10 or 11. Each history appears when its folder exists: `%USERPROFILE%\.claude\projects`, `%USERPROFILE%\.codex`, `%USERPROFILE%\.grok\sessions`. Open in terminal needs Windows Terminal (`wt.exe`) and PowerShell 7 (`pwsh`). Deleting Codex conversations needs Codex Desktop installed; deleting Grok conversations needs the Grok CLI.

## Other details

- English and Simplified Chinese UI; light and dark themes follow Windows.
- Shortcuts: `Ctrl+K` search, `Ctrl+F` find in the open conversation, `Ctrl+B` toggle the sidebar, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` zoom.
- Conversations can be exported as Markdown.

## Limitations

- Windows only.
- Codex's databases, Codex Desktop's state file and Grok's session files have no published format; a new Codex or Grok version can change them.
- Subagent transcripts that Claude Code has already cleaned up cannot be opened; the subagent is still listed.
- For MCP tools, only whether a call returned is shown, not what the tool did.
- Only Markdown edits made with Claude Code's `Edit`, `MultiEdit`, or `Write` are shown; changes made through shell commands are not captured.

## Build from source

Requires Node.js and pnpm.

```bash
pnpm install
pnpm exec install-electron   # Electron's binary is not downloaded during install
pnpm dev                     # development mode
pnpm dist:dir                # unpacked build in release\win-unpacked
pnpm dist                    # zip in release\
pnpm test
```

`node scripts/make-demo-data.mjs --launch` generates fictional Claude Code sessions in `.demo\` and opens the built app on them. The screenshots above were taken this way.

## License

[MIT](LICENSE). Not affiliated with or endorsed by Anthropic, OpenAI, or xAI.
