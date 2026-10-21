# Claude Code Token Monitor

[![Marketplace](https://img.shields.io/badge/VS%20Marketplace-v1.3.0-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=miku3w3.claude-code-token-monitor)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-007ACC)](https://code.visualstudio.com/)

**English** · [简体中文](#简体中文)

Know what every Claude Code conversation actually costs — in the status bar, per message, per turn, and across every session on your machine.

Claude Code writes a JSONL transcript for every session. This extension reads those files locally and turns them into live token and cost numbers. No API keys, no telemetry, no network required for the core features.

```
$(pulse) Fix auth bug | deepseek-v4.1-flash | AI 3.2s | 85K ¥0.012 | total 1.2M ¥0.19
```

---

## Features

| | |
|---|---|
| **Live status bar** | Session title, current model, turn AI time, turn tokens/cost and cumulative totals. Hover for the full breakdown: input, cache hits, cache misses, output, hit rate. |
| **Per-message table** | Every API response with its own token counts, cache usage, duration and cost. De-duplicated by `message.id`, so streamed snapshots are never counted twice. |
| **Sessions dashboard** | Current day / week / month / year / all time, grouped by model when you need it. The full dashboard opens in an editor tab from the status-bar button; the bottom-panel view is opt-in. |
| **Session picker** | Follow any recorded session, not only the newest one. Subagent transcripts are included in both live and historical totals. |
| **Accurate pricing** | 100+ models from Anthropic, OpenAI, Google, Alibaba Bailian (DeepSeek + Qwen), Moonshot, Zhipu, ByteDance, Baidu, xAI and Mistral. Peak/off-peak pricing is applied per channel (Bailian and DeepSeek official use different windows). |
| **Offline-first** | Prices ship inside the extension. Updates are optional and fetched from an Aliyun OSS catalog that works behind restrictive networks. |
| **Custom models** | Add your own provider or private deployment from the command palette — no JSON editing. |
| **11 languages · 7 currencies** | en, zh-CN, zh-TW, ja, ko, es, ar, pt, de, fr, ru · CNY, USD, EUR, JPY, KRW, GBP, auto. |
| **Budget warning** | Get a nudge when the cumulative cost passes a threshold you set. |

## Quick start

1. Install **Claude Code Token Monitor** from the VS Code Marketplace.
2. Use Claude Code as usual — the status bar starts updating within a few seconds.
3. Click the status bar item to open the dashboard.
4. Optional: `Ctrl+Shift+P` → **Claude Code Token Monitor: Select Session to Monitor** to follow an older session.

The extension activates on startup and reads `~/.claude/projects/**/*.jsonl` (or `%USERPROFILE%\.claude\projects` on Windows). Nothing else is required.

> **Want it in the bottom panel?** Set `claudeTokenMonitor.showPanelView` to `true`. It is off by default so the Problems/Output/Terminal area stays clean.

## How token counting works

Claude Code streams several snapshots of the same assistant message into the transcript, and the last snapshot is not always the complete one. Summing every line overcounts by roughly an order of magnitude. This extension instead:

1. groups lines by `message.id`;
2. keeps the snapshot with the highest `output_tokens` (richer cache data breaks ties);
3. counts that snapshot once, at the position of the winning line;
4. treats missing cache fields as `0` and never emits `NaN`.

## Pricing

- **Bundled catalog** — `pricing.json` ships with every release, so costs are correct offline.
- **Daily updates** — a cron job on the maintainer's server refreshes the catalog once a day and publishes it to Aliyun OSS; the extension reads it from there. Each provider is merged, never replaced: a failed scrape keeps yesterday's prices, and any change larger than 5× is rejected as a parsing error.
- **Human-reviewed overrides** — `pricing-overrides.json` holds prices checked by hand (for example Bailian peak/off-peak rates) and always wins over automated data.
- **Unknown models** — shown as `—` rather than guessed. Add a custom model if you use a private deployment.
- **Peak hours** — Alibaba Bailian is peak every day from 08:00 to 22:00 Beijing time. DeepSeek's official API is peak Monday–Friday 09:00–12:00 and 14:00–18:00, excluding statutory holidays. The extension picks the right rate from each message timestamp.

## Settings

Search `claudeTokenMonitor` in Settings (`Ctrl+,`):

| Setting | Description | Default |
|---|---|---|
| `language` | UI language | `auto` |
| `currency` | Display currency | `auto` |
| `exchangeRates` | Override exchange rates (units per 1 USD) | `{}` |
| `customModels` | Custom model pricing entries | `[]` |
| `statusBar.showModelName` | Show the model name in the status bar | `false` |
| `statusBar.compactMode` | Show only title, total tokens and cost | `false` |
| `budgetWarning` | Warn above this cumulative cost (0 = off) | `0` |
| `pollIntervalMs` | Transcript poll interval in ms | `2000` |
| `pricing.autoUpdate` | Refresh pricing and exchange rates automatically | `true` |
| `pricing.updateUrl` | Custom catalog URL (empty = Aliyun OSS catalog) | `""` |
| `showPanelView` | Show the monitor tab in the bottom panel | `false` |

## Commands

| Command | Description |
|---|---|
| `Show Token Usage Detail` | Open the dashboard |
| `Select Session to Monitor` | Follow a specific session |
| `Show Last Message Cost` | Show the cost of the last message |
| `Open Token Monitor Settings` | Open this extension's settings |
| `Refresh Token Data` | Re-read transcripts now |
| `Add Custom Model Pricing` | Guided add of a custom model |
| `Manage Custom Models` | List and delete custom models |
| `Force Refresh Pricing Data` | Fetch the catalog immediately |

## Privacy

- Everything is computed locally from files Claude Code already writes.
- No telemetry, no accounts, no data leaves your machine.
- The only network calls are the optional pricing catalog and exchange-rate downloads. Disable them with `pricing.autoUpdate: false`.

## FAQ

**Why doesn't it use Claude Code's `/cost`?** `/cost` reports the current session only and depends on the CLI's own accounting. Reading the transcripts gives per-message history, historical sessions and subagent usage.

**Why is a cost shown as `—`?** The model is not in the catalog. Add it via **Add Custom Model Pricing** or a `customModels` entry.

**Does it work with non-Anthropic endpoints?** Yes. Any model routed through Claude Code appears in the transcripts; cost is computed from the catalog when the model name is known.

**Does it slow Claude Code down?** No. It only reads files, incrementally, with a byte-offset tailer.

## Development

```bash
npm install
npm test          # compile + 22 unit tests (node:test)
npm run watch     # TypeScript watch mode
npx vsce package  # build a .vsix
```

Pricing changes can be validated without network access:

```bash
node scripts/update-pricing.js --validate
```

Pull requests are welcome. Please run `npm test` before opening one.

## License

[MIT](LICENSE)

---
---

# 简体中文

实时显示 Claude Code 每个会话、每条消息、每一轮的 token 用量与费用。所有数据都在本地从 Claude Code 已经写好的 transcript 文件中读取，不需要 API key，不上传任何数据。

```
$(pulse) 修复登录 Bug | deepseek-v4.1-flash | AI 3.2s | 本轮 85K ¥0.012 | 累计 1.2M ¥0.19
```

## 功能

| | |
|---|---|
| **状态栏实时监控** | 会话标题、当前模型、本轮 AI 耗时、本轮 token/费用、累计用量；悬停查看输入、缓存命中、未命中、输出与命中率 |
| **逐条消息明细** | 每条 API 响应的 token、缓存、耗时、费用；按 `message.id` 去重，流式快照不会重复计数 |
| **会话看板** | 当前 / 每天 / 每周 / 每月 / 每年 / 全部，可按模型分组；点击状态栏按钮在编辑器标签页打开完整看板，底部面板改为自行开启 |
| **会话选择** | 可跟随任意历史会话，不只是最新会话；子代理（subagent）的用量也计入实时与历史统计 |
| **定价准确** | 内置 100+ 模型：Anthropic、OpenAI、Google、阿里云百炼（DeepSeek + Qwen）、Moonshot、智谱、豆包、文心、xAI、Mistral；峰谷价按渠道区分（百炼与 DeepSeek 官方规则不同） |
| **离线优先** | 定价随插件打包；联网更新可选，目录放在阿里云 OSS，国内网络可直连 |
| **自定义模型** | 命令面板引导添加私有部署或新模型，无需手写 JSON |
| **11 种语言 · 7 种货币** | en / zh-CN / zh-TW / ja / ko / es / ar / pt / de / fr / ru · CNY / USD / EUR / JPY / KRW / GBP / 自动 |
| **预算提醒** | 累计费用超过设定阈值时提醒 |

## 快速开始

1. 在 VS Code 扩展市场安装 **Claude Code Token Monitor**。
2. 正常使用 Claude Code，几秒内状态栏就会开始显示数据。
3. 点击状态栏条目打开看板。
4. 可选：`Ctrl+Shift+P` → **Claude Code Token Monitor: Select Session to Monitor** 选择要跟踪的历史会话。

插件读取 `~/.claude/projects/**/*.jsonl`（Windows 下通常是 `%USERPROFILE%\.claude\projects`）。

> **想放回底部面板？** 把 `claudeTokenMonitor.showPanelView` 设为 `true`。默认关闭，避免占用“问题/输出/终端”区域。

## token 统计方式

Claude Code 会把同一条 assistant 消息的多个流式快照写入 transcript，直接把每行相加会把用量放大十几倍。本插件的做法是：

1. 按 `message.id` 分组；
2. 取 `output_tokens` 最大的快照（相同则取缓存信息更完整的一条）；
3. 每条消息只计一次；
4. 缺失的缓存字段按 0 处理，永不产生 `NaN`。

## 定价说明

- **内置目录**：`pricing.json` 随插件发布，离线也能算对。
- **每日更新**：维护者服务器上的 cron 每天更新目录并发布到阿里云 OSS，扩展从 OSS 读取。更新是“合并”而不是“覆盖”：某个供应商抓取失败就保留昨天的价格，单项价格变动超过 5 倍视为解析错误并拒绝。
- **人工复核**：`pricing-overrides.json` 里的价格（例如百炼高峰/低谷价）优先级最高。
- **未知模型**：显示 `—`，绝不按最贵的模型猜价。可自行添加自定义模型。
- **高峰时段**：阿里云百炼每天 08:00–22:00（北京时间）为忙时；DeepSeek 官方为周一至周五 09:00–12:00、14:00–18:00（法定节假日除外）。插件按每条消息的时间自动选择。

## 设置与命令

设置项与命令列表见上方英文部分（`Ctrl+,` 搜索 `claudeTokenMonitor`）。

## 隐私

数据全部在本地计算，无遥测、无账号、不上传。唯一的网络请求是可选的定价目录与汇率下载，可用 `pricing.autoUpdate: false` 关闭。

## 开发

```bash
npm install
npm test          # 编译 + 22 个单元测试
npx vsce package  # 打包 .vsix
```

提交前请先运行 `npm test`。欢迎 PR。

## 许可证

[MIT](LICENSE)