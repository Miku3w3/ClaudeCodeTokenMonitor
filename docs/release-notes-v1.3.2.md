[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-v1.3.2-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=miku3w3.claude-code-token-monitor)　[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)　[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-007ACC)](https://code.visualstudio.com/)

**1.3.2 fixes what 1.3.0 broke.** The status bar follows the conversation you are looking at again, the exchange-rate line no longer says "unknown", and the daily pricing job that feeds the catalog is running again. 1.3.2 itself only renames the repository and adds the missing screenshots to the Chinese README.

---

## 📦 Install

From the Marketplace: **Claude Code Token Monitor** by `miku3w3`, or install the attached `.vsix`:

```bash
code --install-extension claude-code-token-monitor-1.3.2.vsix
```

Reload the window after installing. No API key, no account, no configuration.

---

## 🔧 What's Fixed

### 🪟 The status bar follows the conversation on screen again

1.3.0 rewrote the poller and always displayed whichever transcript had been written most recently, so a background session in another window or another project could take over the status bar. It now follows the Claude Code conversation tab that is actually on screen:

- the tab's session title is matched against the transcripts, including labels VS Code has truncated and labels that stopped tracking the newest message long ago;
- switching to a source file, diff or terminal never blanks the status bar;
- when no conversation tab identifies a session, the freshest session **inside the current workspace** wins — not the freshest anywhere on disk;
- a session picked from the command palette still overrides everything until you move to another conversation.

New setting: `claudeTokenMonitor.followActiveTab` (default `true`). Set it to `false` to go back to "newest output wins".

### 💱 Exchange rates load instead of saying "unknown"

- Rates are fetched directly first and retried through `http.proxy`, so a proxied network gets a real rate instead of "unknown".
- The fetched table and its timestamp are now written to the catalog cache and restored on the next start.
- The tooltip reports where the rate came from — *just now*, *N minutes ago*, *cached* or *built-in* — and never claims the rate is unknown while a usable table is in effect.
- A dead endpoint that burned 8 seconds on every refresh was replaced, and the rate phase is capped at 6 seconds.

### 📈 Daily pricing updates run again

The daily pricing job on the maintainer's server had been exiting before it uploaded anything. It now runs end to end again: **11 providers, 180 models**, refreshed every day and published to Aliyun OSS. Peak/off-peak prices for Bailian and DeepSeek's official API are still resolved per message timestamp.

### 🧪 Tests

**100 automated tests** now cover the pricing rules, exchange-rate normalisation, session following (workspace preference, ambiguous titles, truncated tab labels) and the transcript tailer.

---

## 🐛 Fixed

- Status bar showing a background session instead of the conversation on screen
- Tooltip showing "exchange rate unknown" behind a proxy
- Exchange rates never persisted across restarts
- One dead rate endpoint delaying every pricing refresh
- Daily catalog updates silently failing before upload

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

The exact `.vsix` attached to this release was submitted to VirusTotal:

[VirusTotal report](https://www.virustotal.com/gui/file/8d09c86558080216b5c5881da4045bf51f8d089d963df23da79409ebec5dfa34/detection)

SHA-256: `8d09c86558080216b5c5881da4045bf51f8d089d963df23da79409ebec5dfa34`

---

[Full Changelog](https://github.com/Miku3w3/ClaudeCodeTokenMonitor/blob/master/CHANGELOG.md#132---2026-10-22)

---

# 中文版

**1.3.2 修的是 1.3.0 弄坏的东西。** 状态栏重新跟着你正在看的那个会话走，汇率行不再显示“未知”，给定价目录供数的每日任务也恢复运行了。1.3.2 本身只改了仓库名，并给中文 README 补上了缺的截图。

---

## 📦 安装

在扩展市场搜索 **Claude Code Token Monitor**（发布者 `miku3w3`），或安装附件里的 `.vsix`：

```bash
code --install-extension claude-code-token-monitor-1.3.2.vsix
```

安装后重载窗口即可。不需要 API key、不需要账号、不需要任何配置。

---

## 🔧 修复内容

### 🪟 状态栏重新跟着屏幕上的会话走

1.3.0 重写轮询逻辑后，状态栏总是显示“最后写入”的那个转录，于是别的窗口、别的项目里跑着的会话会把显示抢走。现在重新跟随屏幕上真正打开的 Claude Code 会话标签：

- 用标签上的会话标题去匹配转录，VS Code 截断成省略号的标题、以及早就跟不上最新消息的旧标题都能认出来；
- 切到源码文件、diff、终端标签时，状态栏不会变空；
- 没有会话标签可依据时，优先生效的是**当前工作区里**最新的会话，而不是全盘最新的那个；
- 从命令面板手动指定的会话仍然优先，直到你切换到别的对话。

新增设置 `claudeTokenMonitor.followActiveTab`（默认 `true`）。设为 `false` 就回到“谁最后输出就显示谁”。

### 💱 汇率不再显示“未知”

- 先直连、失败再走 `http.proxy`，走代理的网络也能拿到真实汇率，不会卡在“未知”。
- 抓到的汇率和时间戳现在会写进目录缓存，下次启动直接恢复。
- 悬停提示会说明汇率来源 —— *刚刚更新*、*N 分钟前*、*缓存* 或 *内置*，只要有一张能用的表，就不会再说“未知”。
- 换掉了那个每次刷新白等 8 秒的失效接口，汇率阶段限时 6 秒。

### 📈 定价目录恢复更新

服务器上的每日定价任务之前在上传前就退出了。现在整条链路重新跑通：**11 家厂商、180 个模型**，每天更新并发布到阿里云 OSS。百炼与 DeepSeek 官方的峰谷价仍按每条消息的时间戳分别计算。

### 🧪 测试

**100 项自动化测试**覆盖定价规则、汇率格式归一化、会话跟随（工作区优先、标题歧义、标签截断）以及转录增量读取。

---

## 🐛 修复清单

- 状态栏显示后台会话，而不是屏幕上的对话
- 走代理时悬停提示显示“汇率未知”
- 汇率从不落盘，重启就丢
- 一个失效的汇率接口拖慢每次刷新
- 每日目录更新在上传前静默失败

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

本 Release 附带的 `.vsix` 已提交 VirusTotal 扫描：

[VirusTotal 报告](https://www.virustotal.com/gui/file/8d09c86558080216b5c5881da4045bf51f8d089d963df23da79409ebec5dfa34/detection)

SHA-256：`8d09c86558080216b5c5881da4045bf51f8d089d963df23da79409ebec5dfa34`

---

[完整更新日志](https://github.com/Miku3w3/ClaudeCodeTokenMonitor/blob/master/CHANGELOG.md#132---2026-10-22)