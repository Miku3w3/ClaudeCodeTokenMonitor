[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-v1.3.0-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=miku3w3.claude-code-token-monitor)　[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)　[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-007ACC)](https://code.visualstudio.com/)

**This is a correctness release.** Almost every number the extension showed in 1.2.x was wrong in some way: totals were inflated by streaming snapshots, unknown models were billed at the most expensive rate, subagent usage was missing from history, and the daily price updates never actually reached users. All of that is fixed — and there is now a test suite that keeps it fixed.

---

## 📦 Install

From the Marketplace: **Claude Code Token Monitor** by `miku3w3`, or install the attached `.vsix`:

```bash
code --install-extension claude-code-token-monitor-1.3.0.vsix
```

Reload the window after installing. No API key, no account, no configuration.

---

## ✨ What's New

### 🎯 Numbers you can trust

- **Streaming snapshots are no longer double counted.** Claude Code writes several snapshots of the same assistant message; the old code summed every line and inflated totals by ~13×. Usage is now grouped by `message.id` and only the most complete snapshot is counted.
- **No more `NaN` and no more made-up prices.** A missing cache field is `0`, not `undefined`. A model the catalog doesn't know shows `—` instead of being billed at the provider's most expensive rate.
- **Subagent usage is part of the bill.** Everything under `<session>/subagents/**` is now parsed, tagged and counted — in the live view, in historical sessions, and in the day/week/month/year totals.

### 🧩 Subagent breakdown

The dashboard now shows how much of your spend went to the main agent versus subagents, with a stacked bar, a type column, a filter (all / main only / subagents only) and a per-agent detail table. Colours follow your editor theme.

### 💰 Pricing that actually updates

- **11 providers, 178 models**: Anthropic, OpenAI, Google, xAI, Mistral, Moonshot, Alibaba Bailian (DeepSeek + Qwen), Zhipu, ByteDance, Baidu and DeepSeek's official API.
- **Channel-aware peak pricing.** Bailian is peak every day 08:00–22:00 Beijing time; DeepSeek's official API is peak Monday–Friday 09:00–12:00 and 14:00–18:00, excluding statutory holidays. Each message is priced by its own timestamp.
- **The catalog is now published somewhere that works.** A daily job on the maintainer's server writes the catalog to Aliyun OSS, which is reachable from mainland China — the old GitHub mirror chain was dead for months.
- **`pricing-overrides.json`** holds hand-checked prices and always wins over automated data.
- Peak/off-peak data ships offline: no network needed to get a correct number.

### 🖥️ A dashboard that behaves

- The bottom panel is **opt-in** (`claudeTokenMonitor.showPanelView`) and hidden by default.
- The status-bar button opens a **singleton editor tab** — clicking it twice no longer stacks panels.
- New **Select Session to Monitor** command to follow any recorded session.
- Settings, pause, language switching and the session picker all work from the panel.
- The webview runs under a strict CSP with `data-action` event delegation (no inline handlers).

### 🧪 Built to stay correct

**62 automated tests** cover snapshot de-duplication, malformed and missing cache fields, pricing resolution, peak/off-peak boundaries, holiday handling, transcript tailing, index behaviour and the webview renderer.

### 🔁 Existing installs re-price automatically

Session costs are cached per session. The index now stores a fingerprint of the active price table and re-prices everything when prices change, so upgrading does not leave your history frozen at the old (wrong) numbers.

---

## 🐛 Fixed

- Token totals inflated by ~13× on streamed responses
- `NaN` and `¥0` costs for unknown models
- Subagent usage missing from historical and aggregated views
- Historical session costs never refreshed after a pricing update
- Status-bar dashboard silently failing to open
- Bottom panel appearing without being asked for
- Daily pricing workflow producing data that never reached users

---

## 🔧 Requirements

- VS Code **1.90** or newer
- Claude Code with transcripts under `~/.claude/projects` (`%USERPROFILE%\.claude\projects` on Windows) — created automatically by Claude Code
- Works with any endpoint: Anthropic, DeepSeek, Bailian/Qwen, OpenAI-compatible proxies, or a local proxy

---

## 📈 Status Bar

| Area | Shows |
|---|---|
| Title | First 8 characters of the session title |
| AI time | Time the model spent working in the current turn (excludes waiting for you) |
| Turn | Tokens and cost of the current turn |
| Total | Tokens and cost of the whole session |

Hover the item for the full breakdown: input, cache hits, cache misses, output, hit rate and the last message's cost. A `?` after a cost means the model is unknown to the catalog.

---

[Full Changelog](https://github.com/Miku3w3/ClaudeCodeTokenMonitor/blob/master/changelog.md#130---2026-10-21)

---

# 中文版

**这次是「把数字修对」的版本。** 1.2.x 显示的金额几乎每项都有问题:流式快照被重复累加导致总量虚高十几倍、未知模型按最贵的价格计费、子代理用量没算进历史、每日价格更新从来没真正送到用户手里。全部修好了,并且补上了防止复发的测试。

---

## 📦 安装

在扩展市场搜索 **Claude Code Token Monitor**(发布者 `miku3w3`),或安装附件里的 `.vsix`:

```bash
code --install-extension claude-code-token-monitor-1.3.0.vsix
```

安装后重载窗口即可。不需要 API key、不需要账号、不需要任何配置。

---

## ✨ 更新内容

### 🎯 数字算对了

- **流式快照不再重复计数。** Claude Code 会把同一条 assistant 消息写成多行快照,旧代码逐行相加,总量虚高约 13 倍。现在按 `message.id` 分组,只取最完整的那一条。
- **不再出现 `NaN`,也不再猜价。** 缺失的缓存字段按 0 处理;定价表里没有的模型显示 `—`,而不是套用该厂商最贵模型的价格。
- **子代理的用量也是钱。** `<session>/subagents/**` 下的转录现在会被解析、标记并计入统计 —— 实时视图、历史会话、日/周/月/年汇总都包含。

### 🧩 主/子代理拆分

看板顶部新增主代理与子代理的费用占比条,表格新增类型列,顶栏可按「全部 / 仅主代理 / 仅子代理」筛选,还有一份按 agent 汇总的子代理明细表。配色跟随编辑器主题。

### 💰 价格真的会更新了

- **11 家厂商、178 个模型**:Anthropic、OpenAI、Google、xAI、Mistral、Moonshot、阿里云百炼(DeepSeek + Qwen)、智谱、豆包、文心,以及 DeepSeek 官方。
- **峰谷价按渠道区分。** 百炼每天 08:00–22:00(北京时间)为忙时;DeepSeek 官方为周一至周五 09:00–12:00、14:00–18:00(法定节假日除外)。每条消息按自己的时间戳计价。
- **目录换到能访问的地方了。** 维护者服务器每天生成目录并发布到阿里云 OSS,国内网络可直连 —— 原来那条 GitHub 镜像链已经失效好几个月。
- **`pricing-overrides.json`** 里是人工核对过的价格,优先级永远最高。
- 峰谷数据随插件离线打包,不联网也能算对。

### 🖥️ 看板不再添乱

- 底部面板改为**默认隐藏**,设 `claudeTokenMonitor.showPanelView` 为 `true` 才出现。
- 状态栏按钮打开的是**单例编辑器标签页**,重复点击不会叠加。
- 新增 **Select Session to Monitor** 命令,可以跟随任意历史会话。
- 面板内的设置、暂停、语言切换、会话下拉全部可用。
- Webview 启用严格 CSP,事件改为 `data-action` 委托,不再有内联 handler。

### 🧪 有测试兜底

**62 项自动化测试**覆盖快照去重、缓存字段缺失、定价解析、峰谷边界、法定节假日、转录增量读取、索引行为和界面渲染。

### 🔁 老用户升级后会自动重算

会话费用是按会话缓存的。索引现在会记录当前价格表的指纹,价格一变就整表重算 —— 升级后不会继续显示旧价算出来的错误金额。

---

## 🐛 修复清单

- 流式响应导致 token 总量虚高约 13 倍
- 未知模型显示 `NaN` 或 `¥0`
- 历史与汇总视图漏算子代理用量
- 价格更新后历史会话金额不重算
- 状态栏按钮打不开看板
- 底部面板不请自来
- 每日定价任务产出的数据从未到达用户

---

## 🔧 环境要求

- VS Code **1.90** 或更新版本
- Claude Code 的转录文件位于 `~/.claude/projects`(Windows 为 `%USERPROFILE%\.claude\projects`),由 Claude Code 自动生成
- 任意端点均可:Anthropic、DeepSeek、百炼/Qwen、OpenAI 兼容代理或本地代理

---

## 📈 状态栏格式

| 区域 | 内容 |
|---|---|
| 标题 | 会话标题前 8 个字符 |
| AI耗时 | 本轮模型实际工作时长(不含等你输入的时间) |
| 本轮 | 本轮的 token 与费用 |
| 累计 | 整个会话的 token 与费用 |

鼠标悬停可查看完整明细:输入、缓存命中、缓存未命中、输出、命中率和最后一条消息的费用。金额后面的 `?` 表示该模型不在定价表里。

---

[完整更新日志](https://github.com/Miku3w3/ClaudeCodeTokenMonitor/blob/master/changelog.md#130---2026-10-21)