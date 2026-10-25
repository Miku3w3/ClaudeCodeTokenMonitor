[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-v1.3.5-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=miku3w3.claude-code-token-monitor)　[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)　[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-007ACC)](https://code.visualstudio.com/)

**1.3.5 fixes the status bar going stale when a conversation has a generated title.** Some setups give Claude Code conversations an AI-written title — for example a `UserPromptSubmit` hook that returns `sessionTitle`, or a rename. Claude Code stores that title as `custom-title` / `agent-name` lines in the transcript and shows it on the tab. The extension only knew how to match user messages and `ai-title` lines, so such a title resolved to no session — and on a miss the status bar deliberately keeps the previous conversation, which is why every switch showed another conversation's numbers. Generated titles are now first-class follow labels. The status bar's own title also follows a title that changes while the conversation is open. Conversations without a title are unaffected and keep matching by their user messages.

---

## 📦 Install

From the Marketplace: **Claude Code Token Monitor** by `miku3w3`, or install the attached `.vsix`:

```bash
code --install-extension claude-code-token-monitor-1.3.5.vsix
```

Reload the window after installing. No API key, no account, no configuration.

---

## 🔧 What's Fixed

### 🏷️ A generated title now identifies its conversation

When Claude Code gives a conversation a title, it writes that title to the transcript as a `custom-title` line and an `agent-name` line, and that text is what the tab shows. The extension scanned only `user` and `ai-title` lines, so on a titled conversation the label matched nothing at all. Each session now exposes its generated titles — newest first, with the titles it replaced kept as alternates — followed by `ai-title` and then user messages. A tab therefore resolves to the right session whether its label is a current title, an older title from the same conversation, or a plain user message on an untitled session.

### 🔄 A title regenerated mid-session updates the status bar

Whatever the title mechanism — a hook that recalculates it, or a rename — the status bar used to keep the title it saw when the session was first followed. It now updates as soon as a new title line appears, matching the tab.

### 🧪 Tests

**111 automated tests**, including six new cases: `custom-title` and `agent-name` parsing, the compact/pretty-printed pre-filter, generated-title ordering and dedupe, and a retired title losing to the session that still uses it.

---

## 🐛 Fixed

- Status bar stuck on the previous conversation when the tab title is a generated or renamed title
- Status-bar title not updating when a conversation's title changes mid-session
- Older generated titles no longer matchable as alternate tab labels

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

SHA-256: `c98d9f79f39c890d86699945204f8868a320882be1e271b6dfbf7295251e1c4b`

MD5: `6ba03036ec62fab1c04fc51a42102cea`

VirusTotal: https://www.virustotal.com/gui/file/c98d9f79f39c890d86699945204f8868a320882be1e271b6dfbf7295251e1c4b?nocache=1

---

[Full Changelog](https://github.com/Miku3w3/ClaudeCodeTokenMonitor/blob/master/CHANGELOG.md#135---2026-10-25)

---

# 中文版

**1.3.5 修的是“会话有生成标题时，状态栏跟不上了”。** 有些环境会给 Claude Code 会话起 AI 标题——比如 `UserPromptSubmit` 钩子返回 `sessionTitle`，或者手动重命名。Claude Code 把标题写成转录里的 `custom-title` / `agent-name` 行，标签显示的也是这段文字。扩展原来只认用户消息和 `ai-title` 行，于是这类标题匹配不到会话——而匹配不到时状态栏会故意保留上一个会话，所以每次切换显示的都是别人的数字。现在生成标题是一等标签；会话进行中标题变了，状态栏自己的标题也会跟着更新。没有生成标题的会话不受影响，仍然按用户消息匹配。

---

## 📦 安装

在扩展市场搜索 **Claude Code Token Monitor**（发布者 `miku3w3`），或安装附件里的 `.vsix`：

```bash
code --install-extension claude-code-token-monitor-1.3.5.vsix
```

安装后重载窗口即可。不需要 API key、不需要账号、不需要任何配置。

---

## 🔧 修复内容

### 🏷️ 生成标题也能认出对应的会话

当 Claude Code 给会话一个标题时，会把它写成转录里的 `custom-title` 行加一行 `agent-name`，标签上显示的就是这段文字。扩展原来只扫 `user` 和 `ai-title` 行，所以有标题的会话一个都匹配不上。现在每个会话都会把生成过的标题按“最新在前”暴露出来，旧标题留作备用，然后才是 `ai-title` 和用户消息。无论标签上是当前标题、同一个会话以前的标题，还是没起过标题的会话里的某句用户原话，都能解析回正确的会话。

### 🔄 会话中途重新起标题，状态栏跟着变

不管标题是钩子重新生成的，还是手动改的，以前状态栏只会记住开始跟这个会话时看到的标题；现在新标题行一落盘就更新，和标签保持一致。

### 🧪 测试

**111 项自动化测试**，其中 6 条是本次新增：`custom-title` 与 `agent-name` 解析、紧凑/带空格两种 JSON 的预筛选、生成标题的排序与去重，以及“被替换掉的旧标题输给仍在使用它的会话”。

---

## 🐛 修复清单

- 标签标题是生成标题或重命名后的标题时，状态栏卡在上一个会话
- 会话进行中标题变化时，状态栏标题不更新
- 旧生成标题不再能作为备用标签匹配

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

SHA-256：`c98d9f79f39c890d86699945204f8868a320882be1e271b6dfbf7295251e1c4b`

MD5：`6ba03036ec62fab1c04fc51a42102cea`

VirusTotal：https://www.virustotal.com/gui/file/c98d9f79f39c890d86699945204f8868a320882be1e271b6dfbf7295251e1c4b?nocache=1

---

[完整更新日志](https://github.com/Miku3w3/ClaudeCodeTokenMonitor/blob/master/CHANGELOG.md#135---2026-10-25)