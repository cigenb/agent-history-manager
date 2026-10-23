# CC History Manager

[English](README.md) | 简体中文

管理 [Claude Code](https://code.claude.com) CLI 项目的轻量 Windows 桌面程序：查看和搜索对话记录、管理项目记忆、清理会话数据。适合在终端里用 Claude Code、不用 Claude Desktop 的用户。

程序只处理本机文件。除非你主动重命名或删除，它只读取 Claude Code 的数据，不做修改。

![主界面：对话，以及右侧栏里的 Markdown 改动预览](docs/screenshots/main.png)

## 管理项目和相关数据

每个 Claude Code 对话会在好几个地方留下文件：对话记录、子代理和工具输出、`/rewind` 用的文件改动备份、临时工作区，以及项目记忆。删除对话或项目时，程序会把这些都找出来，按类别列出，并显示大小：

- 每个类别都能展开，逐条查看里面的文件和目录。
- 不想删的类别取消勾选即可。
- 勾选的内容移到回收站，还能还原。

同一对话的多个副本（恢复、回退、分支时产生的会话文件）会一起删除。正在 Claude Code 里打开的对话不能删除或重命名。

![删除确认框：按类别列出关联数据](docs/screenshots/delete.png)

## 管理项目记忆

Claude Code 把每个项目的记忆存成 Markdown 文件，放在 `~/.claude/projects/<项目>/memory/`，由 `MEMORY.md` 做索引。记忆面板里可以看到：

- 索引，以及按类型（用户、反馈、项目、参考）分组的全部记忆。
- 没被索引收录的记忆，以及索引里指向已不存在文件的链接。
- 每条记忆是在哪个对话里写下的，可以直接跳过去。
- **删除**：其他记忆文件里指向它的链接不会断掉，而是加删除线并注明已删除，以后 Claude 读到时能看出是有意删除的。
- **备份**：每次删除都会备份，连同被改动文件的原样，可以一键还原。如果这些文件之后又被改过，还原前会先提示会被覆盖。

![记忆面板](docs/screenshots/memory.png)

## 配合终端看对话

对话随 Claude Code 的写入实时刷新，正在 Claude Code 里打开的对话会有标记。可以开一个小终端窗口负责输入，在这里看对话：

- 只显示你的提问和 Claude 的回答，Markdown 正常渲染。工具调用之间的过程说明默认折叠，工具调用、工具输出和思考过程不显示。Claude 自己接着说时（比如子代理交回报告后），每条回复分开显示。
- **Markdown 修改**显示为 diff 卡片。点「预览」在右侧栏查看文件当前内容，并标出改动的行。
- **子代理和 MCP 调用**列在右侧栏，带状态。点子代理可以查看它自己的对话。
- **在终端中继续**：在项目目录新开一个 Windows Terminal 标签，运行 `claude --resume <id>`。

## 搜索

一个搜索框同时搜会话标题和提问、回答的正文。打开结果会跳到命中的那条消息，并高亮关键词。

![搜索结果和子代理对话](docs/screenshots/search-subagent.png)

## 读取和写入

程序读取 `~/.claude`，只在以下操作时写入：

- **重命名**对话：和 `/rename` 一样，在会话文件末尾追加一条 `custom-title` 记录。
- **删除**对话或项目：把你勾选的文件移到回收站。
- **删除记忆**：把记忆文件移进程序自己数据目录里的备份，并更新其他记忆文件里指向它的链接。还原时把文件放回原处。

程序自己的设置和缓存（项目顺序、窗口大小、会话索引缓存）存在它自己的数据目录里。不读取 Claude Code 的登录凭据，不调用 Claude API，不发起任何网络请求。

## 安装

1. 从 [Releases](https://github.com/cigenb/cc-history-manager/releases) 下载 `CC-History-Manager-<版本>-win-x64.zip`。
2. 解压到任意位置，运行 `CC History Manager.exe`。

不需要安装。设置存在程序旁边的 `data` 文件夹里（该位置不可写时改用 `%APPDATA%\CC History Manager`）。卸载时删除整个文件夹即可。

运行环境：Windows 10 或 11，Claude Code 的会话位于 `%USERPROFILE%\.claude\projects`。「在终端中继续」需要 Windows Terminal（`wt.exe`）和 PowerShell 7（`pwsh`）。

## 其他

- 界面支持简体中文和英文，深浅色跟随 Windows。
- 快捷键：`Ctrl+K` 搜索，`Ctrl+F` 在当前对话中查找，`Ctrl+B` 显示或隐藏侧栏，`Ctrl+=` / `Ctrl+-` / `Ctrl+0` 缩放。
- 对话可以导出为 Markdown。

## 限制

- 只支持 Windows。
- Claude Code 已经清理掉的子代理记录无法打开，子代理本身仍会列出。
- MCP 工具只显示调用是否返回，不显示工具内部做了什么。
- 只显示用 `Edit`、`MultiEdit`、`Write` 对 Markdown 文件做的修改；通过 shell 命令改的文件抓不到。

## 从源码构建

需要 Node.js 和 pnpm。

```bash
pnpm install
pnpm exec install-electron   # 安装依赖时不会下载 Electron 本体
pnpm dev                     # 开发模式
pnpm dist:dir                # 免安装目录 release\win-unpacked
pnpm dist                    # release\ 下的 zip
```

`node scripts/make-demo-data.mjs --launch` 会在 `.demo\` 生成虚构的会话，并用它打开构建好的程序。上面的截图就是这样截的。

## 许可

[MIT](LICENSE)。本项目与 Anthropic 无关，也未获其认可。
