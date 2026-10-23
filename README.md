# CC History Manager

English | [简体中文](README.zh-CN.md)

A lightweight Windows desktop app for managing [Claude Code](https://code.claude.com) CLI projects: read and search your conversation history, manage project memories, and clean up session data. It is meant for people who work with Claude Code in the terminal and do not use Claude Desktop.

It runs entirely on local files. Claude Code's data is only read, except when you rename or delete something yourself.

![Main window: a conversation with a Markdown edit previewed in the right panel](docs/screenshots/main.png)

## Manage projects and their data

Each Claude Code conversation leaves files in several places: the transcript, subagent and tool output, file backups for `/rewind`, a temporary workspace, and the project's memories. When you delete a conversation or a project, the app collects all of them and shows them grouped by category, with sizes:

- Expand any category to see every file and folder it contains.
- Uncheck the categories you want to keep.
- Everything checked goes to the Recycle Bin, so it can be restored.

Copies of one conversation (created when a session is resumed, rewound, or forked) are deleted together. Conversations that are currently open in Claude Code cannot be deleted or renamed.

![Delete dialog listing related data by category](docs/screenshots/delete.png)

## Manage project memories

Claude Code keeps per-project memories as Markdown files in `~/.claude/projects/<project>/memory/`, indexed by `MEMORY.md`. The memory panel shows them:

- The index, plus every memory grouped by type (user, feedback, project, reference).
- Memories missing from the index, and index links pointing to files that no longer exist.
- A link to the conversation that wrote each memory.
- **Delete**: links to the memory in other memory files are struck through and marked as deleted rather than left broken, so Claude can tell it was removed on purpose.
- **Backups**: every deletion is backed up, with the original versions of every file it changed, and can be restored in one click. If those files changed again afterwards, you are asked before they are overwritten.

![Memory panel](docs/screenshots/memory.png)

## Read conversations next to your terminal

Conversations refresh as Claude Code writes them, and the ones open in Claude Code are marked. You can keep a small terminal window for typing and read the conversation here:

- Only your prompts and Claude's replies are shown, with Markdown rendered. Commentary written between tool calls is folded; tool calls, tool output, and thinking are left out. When Claude continues on its own (for example after a subagent reports back), each reply stays separate.
- **Markdown edits** appear as diff cards. **Preview** opens the file's current content in the right panel with the changed lines highlighted.
- **Subagents and MCP calls** are listed in the right panel with their status. Click a subagent to read its own conversation.
- **Resume in a terminal** opens a Windows Terminal tab in the project folder running `claude --resume <id>`.

## Search

One search box covers conversation titles and the text of prompts and replies. Results open at the matching message with the search terms highlighted.

![Search results and a subagent conversation](docs/screenshots/search-subagent.png)

## What it reads and writes

The app reads `~/.claude`. It writes there only when you:

- **Rename** a conversation: appends a `custom-title` record to the session file, as `/rename` does.
- **Delete** a conversation or project: moves the files you selected to the Recycle Bin.
- **Delete a memory**: moves the file into a backup in the app's own data folder and updates links to it in the other memory files. Restoring puts the files back.

Its own settings and caches (project order, window size, the session index cache) stay in its data folder. It does not read Claude Code's login credentials, does not call the Claude API, and makes no network requests.

## Install

1. Download `CC-History-Manager-<version>-win-x64.zip` from [Releases](https://github.com/cigenb/cc-history-manager/releases).
2. Extract it anywhere and run `CC History Manager.exe`.

There is no installer. Settings are stored in a `data` folder next to the exe (or in `%APPDATA%\CC History Manager` if that folder is not writable). To uninstall, delete the folder.

Requirements: Windows 10 or 11, with Claude Code sessions in `%USERPROFILE%\.claude\projects`. Resuming in a terminal needs Windows Terminal (`wt.exe`) and PowerShell 7 (`pwsh`).

## Other details

- English and Simplified Chinese UI; light and dark themes follow Windows.
- Shortcuts: `Ctrl+K` search, `Ctrl+F` find in the open conversation, `Ctrl+B` toggle the sidebar, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` zoom.
- Conversations can be exported as Markdown.

## Limitations

- Windows only.
- Subagent transcripts that Claude Code has already cleaned up cannot be opened; the subagent is still listed.
- For MCP tools, only whether a call returned is shown, not what the tool did.
- Only Markdown edits made with `Edit`, `MultiEdit`, or `Write` are shown; changes made through shell commands are not captured.

## Build from source

Requires Node.js and pnpm.

```bash
pnpm install
pnpm exec install-electron   # Electron's binary is not downloaded during install
pnpm dev                     # development mode
pnpm dist:dir                # unpacked build in release\win-unpacked
pnpm dist                    # zip in release\
```

`node scripts/make-demo-data.mjs --launch` generates fictional sessions in `.demo\` and opens the built app on them. The screenshots above were taken this way.

## License

[MIT](LICENSE). Not affiliated with or endorsed by Anthropic.
