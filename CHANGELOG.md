# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.1] - 2026-10-22

### Fixed

- **The status bar stopped following the conversation on screen** — the 1.3.0 rewrite dropped the tab-following logic and always displayed whichever transcript had been written most recently, so a session running in another window or another project would hijack the display. The status bar again follows the Claude Code conversation tab that is on screen (matched by its session title, including VS Code's truncated labels and labels that no longer track the newest message), falls back to the freshest session **inside the current workspace** rather than anywhere on disk, and never blanks itself just because the active tab is a source file. A command-palette pick still wins until you move to a different conversation.
- **The tooltip showed "exchange rate unknown" whenever the display currency differed from the model's pricing currency** — the rate APIs were only tried over a direct connection, so a network that reaches the internet through a proxy (or blocks those hosts) never got a rate, and the label stayed at "unknown" even though a working built-in rate table was already in use. Rates are now fetched directly first and retried through the configured `http.proxy`, and the tooltip reports the real provenance — *fetched N minutes ago*, *cached*, or *built-in* — instead of claiming the rate is unknown.
- **Exchange rates were never persisted** — the cached catalog carried no `rates` field, so every restart began with no rate history at all. The fetched table (and its timestamp) is now written to the cache and restored on the next start, which keeps the tooltip accurate while offline.
- **A dead rate endpoint burned 8 seconds of every refresh** — `api.exchangerate-api.com/v6` returns 404 without an API key. It is replaced by `frankfurter.dev`, and the rate phase is capped at 6 seconds so the catalog mirrors keep their share of the fetch budget.

### Added

- `claudeTokenMonitor.followActiveTab` (default `true`) — set it to `false` to always show the session that produced the latest output instead of the conversation tab on screen.

---

## [1.3.0] - 2026-10-21

### Fixed

- **Token totals were inflated by 13×** — streaming snapshots of the same API response were counted once per line. Usage is now grouped by `message.id` and only the most complete snapshot is counted.
- **Cost could show `NaN` or `¥0` for unknown models** — every number now passes a single sanitizer, and models without known pricing are shown as `—` instead of being billed at the most expensive provider's rate.
- **Historical sessions were missing subagent usage** — subagent transcripts (`<session>/subagents/**/*.jsonl`) are now indexed and counted in both live and historical totals.
- **Historical session costs went stale** — the session index cached the cost computed with whatever price table was active the first time a session was scanned, and never re-priced it. After a pricing fix, old sessions kept showing the old numbers forever. The index now stores a fingerprint of the active price table and re-prices every session when it changes.
- **The status-bar dashboard did not open** — the webview is now a singleton editor panel that survives re-renders, with working settings, session picker, pause and language switching.
- **Daily pricing updates never reached users** — the updater now writes the v2 catalog, rejects implausible price jumps, keeps human-reviewed Bailian peak/off-peak prices, and publishes the result to Aliyun OSS every day.
- **The extension hijacked the bottom panel** — the panel view is opt-in and hidden by default; the status-bar button opens the full dashboard in an editor tab.

### Added

- Session picker command (`Claude Code Token Monitor: Select Session to Monitor`) to follow any recorded session instead of only the most recent one.
- Channel-aware peak/off-peak pricing: Alibaba Bailian is peak every day 08:00–22:00 Beijing time; DeepSeek's official API is peak Monday–Friday 09:00–12:00 and 14:00–18:00, excluding statutory holidays (91 dates for 2024–2026 are built in).
- Pricing catalog now covers 11 providers (100+ models). Domestic prices come from each vendor's official pricing page; USD providers use the community-maintained models.dev catalog.
- `pricing-overrides.json` for human-reviewed prices that automated updates can never overwrite.
- Automated tests (`npm test`) covering deduplication, pricing, replay and transcript tailing.
- `pricing.json` schema v2 with provider ids, aliases and per-model verification notes.

### Changed

- Pricing is checked on startup and every 6 hours, and the catalog refreshes at most once per day. Bundled prices always work offline.
- The session index is written atomically and re-scans incrementally instead of re-parsing every transcript.
- README rewritten in English and Chinese with a quick start, privacy notes and pricing documentation.

### Removed

- The inline `onclick` handlers in the webview (replaced with a CSP-safe delegated listener).
- Obsolete tab-tracking, retry timers and duplicated transcript parsers.

---

## [1.2.1] - 2026-06-26

### Changed

- Updated README, changelog and Marketplace listing details.

---

## [1.2.0] - 2026-06-25

### Changed

- New Claude warm-orange (`#D97757`) icon with a white bar chart and a green dollar sign.

---

## [1.1.2] - 2026-06-25

### Fixed

- "By Model" toggle no longer jumps back to the current session when clicked while viewing a historical session.
- "By Model" state survives time-range tab switches.

---

## [1.1.1] - 2026-06-25

### Fixed

- "By Model" toggle no longer resets to the current session when viewing a historical session.

---

## [1.1.0] - 2026-06-25

### Changed

- Time-range statistics filter messages by their own timestamps instead of summing session-lifetime totals.
- Transcript parsing is cached by file modification time, making tab switches instant.

### Removed

- Redundant `aggregateModelStats()` from the session store.

---

## [1.0.6] - 2026-06-24

### Added

- Per-turn AI working time, excluding idle time spent waiting for approvals or user input.
- Per-turn cumulative tokens and cost in the status bar.

### Fixed

- Dynamic extension id for the settings command on non-standard VS Code builds.

---

## [1.0.0] - 2026-06-23

### Added

- Time-range filters: Current, Daily, Weekly, Monthly, Yearly, All.
- Session selector for browsing historical sessions.
- "By Model" grouping.
- Automatic exchange rates and model pricing updates.
- 11-language UI (en, zh-CN, zh-TW, ja, ko, es, ar, pt, de, fr, ru).

### Fixed

- `NaN` cost display caused by unsanitized remote pricing data.
- Session dropdown reset by auto-refresh.
- Token double counting in aggregated views.

---

## [0.12.1] - 2026-06-23

### Added

- Time-range filters and the persistent session index at `~/.claude/token-tracker/sessions.json`.
- "By Model" toggle.

### Fixed

- Session store deduplicates by message UUID, fixing inflated totals.

---

## [0.12.0] - 2026-06-23

### Added

- Webview filter bar with time-range tabs, session selector and by-model toggle.
- Persistent session index for cross-session aggregation.

---

## [0.11.5] - 2026-06-22

### Added

- Eight-card stats dashboard, per-model detail panels, pause/resume, model column.

### Fixed

- Expanded model panels survive auto-refresh; new sessions are detected on the first message.

---

## [0.11.1] - 2026-06-22

### Added

- Standalone editor-tab dashboard, settings button, per-message tooltip, custom model pricing commands.
- Automatic pricing and exchange-rate updates with a 24-hour cache.
- 18 additional built-in models across nine providers.

### Changed

- Status-bar click opens the dashboard; 11 languages total.

---

## [0.8.0] - 2026-06-22

### Added

- Chinese UI, DeepSeek pricing, thinking time, per-message token and cost display.
- Status bar with session title, thinking time, latest tokens/cost and cumulative totals.

---

## [0.1.0 – 0.7.2] - 2026-06-21 to 2026-06-22

- Initial development and iteration on tab switching, session titles and cold sessions.

---

[1.3.0]: https://github.com/Miku3w3/ClaudeCodeUsage/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/Miku3w3/ClaudeCodeUsage/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Miku3w3/ClaudeCodeUsage/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/Miku3w3/ClaudeCodeUsage/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Miku3w3/ClaudeCodeUsage/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Miku3w3/ClaudeCodeUsage/compare/v1.0.6...v1.1.0
[1.0.6]: https://github.com/Miku3w3/ClaudeCodeUsage/compare/v1.0.0...v1.0.6
[1.0.0]: https://github.com/Miku3w3/ClaudeCodeUsage/compare/v0.12.1...v1.0.0