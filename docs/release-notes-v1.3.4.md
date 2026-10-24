[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-v1.3.4-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=miku3w3.claude-code-token-monitor)　[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)　[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-007ACC)](https://code.visualstudio.com/)

**1.3.4 fixes the status bar getting stuck on the wrong conversation.** Some Claude Code tabs showed another conversation's tokens and cost — switching away and back was the only way out. The cause was two things at once: Claude Code truncates tab titles at 24 characters, and a pasted path makes several conversations start with the same 24 characters, so the label could not identify the tab. It now resolves those collisions in three steps and re-checks itself a second later.

---

## 📦 Install

From the Marketplace: **Claude Code Token Monitor** by `miku3w3`, or install the attached `.vsix`:

```bash
code --install-extension claude-code-token-monitor-1.3.4.vsix
```

Reload the window after installing. No API key, no account, no configuration.

---

## 🔧 What's Fixed

### 🪟 A tab whose title is cut off no longer shows another conversation

Claude Code cuts every tab title to **24 characters plus `…`**. Paste a path and the cut lands in the middle of it: `"C:\Users\Administrator\…` is a prefix of both `…\Desktop\MC` and `…\Desktop\SSH实验.pdf`. Two conversations claim the same label, and the extension used to refuse to pick one — leaving the status bar on whatever session was displayed before, i.e. another conversation's numbers.

The label is now resolved in three steps:

- **Position** — the tab keeps the name it was given, so the session where that text sits closest to its newest message wins.
- **Running state** — when two sessions claim the label at the same position, the one Claude Code currently has a process for wins.
- **Freshness in this window** — when nothing is running, the freshest session in the current workspace wins. A guess that corrects itself beats a status bar stuck on the previous conversation.

### ♻️ First focus of a tab is no longer a guess

Opening a conversation tab *starts* its Claude Code process, so for about a second the conversation on screen has no session file and can even be missing from the candidate list. A binding that needed the deep label scan, or that landed on a session with no process, is now re-resolved a second later — the status bar corrects itself instead of staying wrong until the next switch.

### 🔎 New: `follow-log.jsonl`

Every tab resolution is appended to `~/.claude/token-monitor/follow-log.jsonl` (last 300 lines kept): timestamp, tab label, which session it resolved to, whether the deep scan was needed and whether that session was running. "The status bar follows the wrong conversation" was previously impossible to diagnose after the fact — the only state on disk was the session that ended up displayed.

### 🧪 Tests

**105 automated tests**, including four new cases for truncated tab labels: identical prefixes at the same position, a fresh process that has not registered yet, two running sessions sharing a label, and several stale sessions.

---

## 🐛 Fixed

- Status bar stuck on another conversation when the tab title is truncated mid-path
- First focus of a conversation tab resolving to the wrong session while its process starts
- No record of what a tab switch actually resolved to

---

## 🔧 Requirements

- VS Code **1.90** or newer
- Claude Code with transcripts under `~/.claude/projects` (`%USERPROFILE%\.claude\projects` on Windows)
- Works with any endpoint: Anthropic, DeepSeek, Bailian/Qwen, OpenAI-compatible proxies, or a local proxy

---

## 📈 Status Bar

| Area | Shows |
|---|---|
| Title | First 8 characters of the conversation on screen |
| AI time | Time the model spent working in the current turn |
| Turn | Tokens and cost of the current turn |
| Total | Tokens and cost of the whole session |

Hover for input, cache hits, cache misses, output, hit rate, the last message's cost and the exchange rate in effect.

---

## 🔐 Verification

The exact `.vsix` attached to this release:

SHA-256: `a09dc8cc1be55924b863739994ac163202149824243f1e776c9a150ad7feffc3`

MD5: `e65617be770bbc1daf19e3c92bab3779`

---

[Full Changelog](https://github.com/Miku3w3/ClaudeCodeTokenMonitor/blob/master/CHANGELOG.md#134---2026-10-24)

---

# 中文版

**1.3.4 修的是“状态栏卡在别的会话上”。** 有些 Claude Code 标签会显示成另一个会话的 token 和费用，只有切走再切回来才能恢复。原因是两件事叠在一起：Claude Code 把标签标题截成 24 个字符，而粘贴过的路径会让好几个会话的开头 24 个字符完全一样，于是这个标签无法再确定是哪个会话。现在这类撞车按三步判定，并在一秒后自查一次。

---

## 📦 安装

在扩展市场搜索 **Claude Code Token Monitor**（发布者 `miku3w3`），或安装附件里的 `.vsix`：

```bash
code --install-extension claude-code-token-monitor-1.3.4.vsix
```

安装后重载窗口即可。不需要 API key、不需要账号、不需要任何配置。

---

## 🔧 修复内容

### 🪟 标题被截断的标签，不会再显示成别的会话

Claude Code 会把每个标签标题截成 **24 个字符加 `…`**。粘贴一个路径进去，截断点正好落在路径中间：`"C:\Users\Administrator\…` 既是 `…\Desktop\MC` 的前缀，也是 `…\Desktop\SSH实验.pdf` 的前缀。两个会话抢同一个标签，扩展以前干脆不选——状态栏就留在切换前的那个会话上，也就是显示着别人的数字。

现在按三步判定：

- **位置**——标签一旦生成就不再改名，所以“这段文字离哪个会话的最新消息更近”是第一判据。
- **运行状态**——两个会话在同一位置并列时，Claude Code 当前有进程的那个胜出。
- **本窗口新鲜度**——都没有进程时，当前工作区里最新的那个胜出。猜一次并能自我纠正，好过一直卡在上一个会话。

### ♻️ 标签第一次点开时不再靠猜

打开一个会话标签会**启动**它对应的 Claude Code 进程，所以最初大约一秒内，屏幕上那个会话既没有会话文件、甚至可能根本不在候选表里。现在只要这次绑定用到了深度扫描、或者绑到的会话没有进程，就会在一秒后重新判定一次——状态栏会自己纠正，而不是一直错到你下一次切换。

### 🔎 新增 `follow-log.jsonl`

每次标签解析都会追加一行到 `~/.claude/token-monitor/follow-log.jsonl`（只保留最后 300 行）：时间、标签原文、解析到的会话、是否用了深度扫描、该会话当时是否在运行。"状态栏跟错会话"以前事后完全没法查——磁盘上唯一留下的只有最后显示的那个会话。

### 🧪 测试

**105 项自动化测试**，其中 4 条是本次新增的标签截断用例：同位置前缀相同、进程尚未注册、两个运行中的会话共用标签、多个已停止的会话共用标签。

---

## 🐛 修复清单

- 标签标题在路径中间被截断时，状态栏卡在别的会话上
- 首次点开会话标签时，进程还在启动，绑到了错误的会话
- 切换标签到底解析成了什么，无据可查

---

## 🔧 环境要求

- VS Code **1.90** 或更新版本
- Claude Code 的转录文件位于 `~/.claude/projects`（Windows 为 `%USERPROFILE%\.claude\projects`）
- 任意端点均可：Anthropic、DeepSeek、百炼/Qwen、OpenAI 兼容代理或本地代理

---

## 📈 状态栏格式

| 区域 | 内容 |
|---|---|
| 标题 | 屏幕上那个会话标题的前 8 个字符 |
| AI耗时 | 本轮模型实际工作时长 |
| 本轮 | 本轮的 token 与费用 |
| 累计 | 整个会话的 token 与费用 |

悬停可查看输入、缓存命中、缓存未命中、输出、命中率、最后一条消息的费用，以及当前生效的汇率。

---

## 🔐 校验

本 Release 附带的 `.vsix`：

SHA-256：`a09dc8cc1be55924b863739994ac163202149824243f1e776c9a150ad7feffc3`

MD5：`e65617be770bbc1daf19e3c92bab3779`

---

[完整更新日志](https://github.com/Miku3w3/ClaudeCodeTokenMonitor/blob/master/CHANGELOG.md#134---2026-10-24)