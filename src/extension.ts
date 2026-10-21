// Claude Code Token Monitor - VSCode Extension v1.0.0 (Universal Edition)
// Architecture: v0.8.0 event-driven tab switching + mtime-based session tracking,
// with multi-provider pricing, i18n UI, and full VSCode configuration support.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseLine } from './parsers/TranscriptParser';
import {
  calculateCostDetail, normalizeModelName, formatCost, abbreviateTokens,
  resolvePricing, convertCurrency,
} from './model/CostCalculator';
import { normalizeUsage, isBetterSnapshot } from './core/usage';
import { TranscriptTailer } from './core/transcriptTailer';
import { replayTranscriptLines, type TranscriptSource } from './core/replay';
import { buildAgentStats, recentMessages } from './core/agentView';
import { claudeDir, tokenMonitorDir, tokenTrackerDir, transcriptPath as getTranscriptPath } from './utils/paths';
import type { Currency, PerMessageStats, SessionPidFile, ClaudeReadableData, TimeRange, AggregatedData, SessionIndexEntry, ModelStatEntry } from './model/types';
import { DetailPanel } from './ui/DetailPanel';
import type { PanelData } from './ui/DetailPanel';
import { t, initI18n, isRTL } from './i18n/index';
import { getConfig } from './config/settings';
import { checkForUpdates, loadBundledPricing } from './model/pricing-fetcher';
import { getRatesUpdatedAt } from './model/pricing';
import type { ExtensionConfig } from './model/types';
import * as SessionStore from './data/SessionStore';

// ─── Globals ──────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let detailPanel: DetailPanel;
/** Reused standalone dashboard panel (status-bar button). */
let standalonePanel: vscode.WebviewPanel | null = null;
let standaloneSyncTimer: ReturnType<typeof setInterval> | null = null;
/** Periodic pricing refresh while the editor stays open for days. */
let pricingRefreshTimer: ReturnType<typeof setInterval> | null = null;

// Transcript parse cache — keyed by file path, invalidated on mtime change
const transcriptCache = new Map<string, { mtimeMs: number; messages: PerMessageStats[] }>();

// Extension ID (set during activation)
let extensionId = 'local.claude-code-token-monitor';

// Current session state
let currentSessionId = '';
let currentTitle = '';
let currentModel = 'unknown';
let cumulativeInput = 0, cumulativeOutput = 0, cumulativeCacheRead = 0, cumulativeCacheCreation = 0, cumulativeCost = 0;
let messageCount = 0;
let messages: PerMessageStats[] = [];
let lastTranscriptPath = '';
/** Main transcript tailer (owns its byte offset and partial-line buffer). */
const mainTailer = new TranscriptTailer();
/** Per-file tailers for <sessionId>/subagents/** transcripts. */
const subagentTailers = new Map<string, TranscriptTailer>();
/** message.id → index in `messages`, so later snapshots can replace earlier ones. */
const messageIndexByKey = new Map<string, number>();
let unknownCostMessages = 0;
let pendingUserTs: number | null = null;
let turnAiAccumulatorMs = 0;
let turnTokens = 0;
let turnCost = 0;

// Session selection: explicit override set via the "Select Session" command.
// Without an override the poller follows the most recently modified transcript.
let activeSessionOverride: { sessionId: string; cwd: string } | null = null;
const sessionTitleCache = new Map<string, string>();

// Configuration snapshot (refreshed on change)
let currentConfig: ExtensionConfig = {} as ExtensionConfig;
// Budget warning: only show once per threshold exceed
let budgetWarned = false;
// Debounced full index refresh (used when the live session has subagent files)
let indexRefreshTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Path encoding (v0.6.0 fix: no dash collapsing) ─────────────
function encodeProjectPath(cwd: string): string {
  return cwd
    .replace(/:\\/g, '--')
    .replace(/:\//g, '--')
    .replace(/\\/g, '-')
    .replace(/\//g, '-');
}

// ─── Session scanning (v0.6.0 fix: transcript existence instead of PID) ──
function scanSessions(): Array<{ pid: number; sessionId: string; cwd: string; startedAt: number }> {
  const sessionsDir = path.join(claudeDir(), 'sessions');
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(sessionsDir, { withFileTypes: true }); } catch { return []; }

  const result: Array<{ pid: number; sessionId: string; cwd: string; startedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const pid = parseInt(entry.name.replace('.json', ''), 10);
    if (isNaN(pid)) continue;

    const filePath = path.join(sessionsDir, entry.name);
    let data: SessionPidFile;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { continue; }

    const tp = path.join(claudeDir(), 'projects', encodeProjectPath(data.cwd), data.sessionId + '.jsonl');
    if (!fs.existsSync(tp)) continue;

    result.push({ pid, sessionId: data.sessionId, cwd: data.cwd, startedAt: data.startedAt });
  }
  return result;
}

// ─── Title extraction ──────────────────────────────────────
function getSessionTitle(s: { cwd: string; sessionId: string }): string {
  const cached = sessionTitleCache.get(s.sessionId);
  if (cached) return cached;

  try {
    const encoded = encodeProjectPath(s.cwd);
    const tp = path.join(claudeDir(), 'projects', encoded, s.sessionId + '.jsonl');
    const stat = fs.statSync(tp);

    // Search backwards in 16KB chunks for ai-title
    let offset = stat.size;
    while (offset > 0) {
      const start = Math.max(0, offset - 16384);
      const len = offset - start;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(tp, 'r');
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
      const lines = buf.toString('utf-8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === 'ai-title' && obj.aiTitle) {
            sessionTitleCache.set(s.sessionId, obj.aiTitle);
            return obj.aiTitle;
          }
        } catch { /* skip */ }
      }
      if (start === 0) break;
      offset = start;
    }

    // No ai-title — fall back to first user message text
    const headBuf = Buffer.alloc(Math.min(8192, stat.size));
    const fd2 = fs.openSync(tp, 'r');
    fs.readSync(fd2, headBuf, 0, headBuf.length, 0);
    fs.closeSync(fd2);
    for (const line of headBuf.toString('utf-8').split('\n')) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && obj.message?.role === 'user') {
          const content = obj.message.content;
          if (typeof content === 'string' && content.trim()) {
            const title = content.trim().slice(0, 40);
            sessionTitleCache.set(s.sessionId, title);
            return title;
          }
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === 'text' && c.text && !c.tool_use_id) {
                const title = c.text.slice(0, 40);
                sessionTitleCache.set(s.sessionId, title);
                return title;
              }
            }
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* file not found */ }
  return '';
}

// ─── Main poll ────────────────────────────────────────────────
function poll(): void {
  try {
    // 1. Find sessions with live transcripts
    const sessions = scanSessions();
    if (sessions.length === 0 && !activeSessionOverride) {
      if (currentSessionId) resetState();
      updateStatusBar();
      return;
    }

    // 2. Pick the active session
    let active: { sessionId: string; cwd: string } | null = null;

    if (activeSessionOverride) {
      const overrideActive = sessions.find(s => s.sessionId === activeSessionOverride!.sessionId);
      if (overrideActive) {
        active = overrideActive;
      } else {
        const tp = path.join(claudeDir(), 'projects', encodeProjectPath(activeSessionOverride.cwd), activeSessionOverride.sessionId + '.jsonl');
        if (fs.existsSync(tp)) {
          active = activeSessionOverride;
        } else {
          activeSessionOverride = null;
        }
      }
    }

    if (!active) {
      if (sessions.length === 0) {
        updateStatusBar();
        return;
      }
      sessions.sort((a, b) => {
        const aTp = path.join(claudeDir(), 'projects', encodeProjectPath(a.cwd), a.sessionId + '.jsonl');
        const bTp = path.join(claudeDir(), 'projects', encodeProjectPath(b.cwd), b.sessionId + '.jsonl');
        let aMtime = 0, bMtime = 0;
        try { aMtime = fs.statSync(aTp).mtimeMs; } catch { /* */ }
        try { bMtime = fs.statSync(bTp).mtimeMs; } catch { /* */ }
        return bMtime - aMtime;
      });
      active = sessions[0];
    }

    // 3. Build transcript path
    const encoded = encodeProjectPath(active.cwd);
    const tp = path.join(claudeDir(), 'projects', encoded, active.sessionId + '.jsonl');

    // 4. If session (or transcript path) changed, reset all state
    if (active.sessionId !== currentSessionId) {
      currentSessionId = active.sessionId;
      const indexed = SessionStore.loadIndex().sessions[active.sessionId];
      currentTitle = indexed?.title || getSessionTitle(active) || '';
      budgetWarned = false;
      resetSessionData();
      lastTranscriptPath = tp;
    } else if (tp !== lastTranscriptPath) {
      resetSessionData();
      lastTranscriptPath = tp;
    }

    // 5. Read the main transcript and every subagent transcript
    let changed = false;

    const mainRead = mainTailer.read(tp);
    if (mainRead.missing) { updateStatusBar(); return; }
    if (mainRead.truncated) {
      // The tailer has already replayed from byte 0; clear the accumulators
      // before applying the replayed events.
      resetAccumulatorState();
    }
    for (const event of mainRead.events) {
      if (processEvent(event, false)) changed = true;
    }

    if (readSubagentEvents(active.sessionId, tp)) changed = true;

    if (changed) {
      updateStatusBar();
      writeClaudeReadable();
      pushToWebview();
      // Persist current session summary to the index
      persistCurrentSession(active.cwd);
    } else {
      updateStatusBar();
    }
  } catch (err) {
    console.error('[TokenMonitor] poll error:', err);
  }
}

/**
 * Apply one parsed transcript event to the live session state.
 * Returns true when anything user-visible changed.
 */
function processEvent(
  event: NonNullable<ReturnType<typeof parseLine>>,
  fromSubagent: boolean,
  agentId?: string,
): boolean {
  if (fromSubagent) {
    // Subagent transcripts contain their own user prompts and tool results;
    // only their assistant usage belongs in the parent session's totals.
    if (event.type !== 'assistant' || !event.usage) return false;
  } else if (event.sessionId && currentSessionId && event.sessionId !== currentSessionId) {
    return false;
  }

  if (event.type === 'ai-title' && event.title) {
    currentTitle = event.title;
    sessionTitleCache.set(currentSessionId, event.title);
    return true;
  }

  if (event.type === 'user') {
    messages.push({
      uuid: event.uuid, timestamp: event.timestamp, isUserMessage: true,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      model: '', costCNY: 0, costKnown: true, thinkingTimeMs: null,
    });
    pendingUserTs = new Date(event.timestamp).getTime();
    turnAiAccumulatorMs = 0; // New real user message → reset turn accumulators
    turnTokens = 0;
    turnCost = 0;
    return true;
  }

  if (event.type === 'tool_result') {
    // Tool result — update reference timestamp for next assistant delta,
    // but do NOT add to messages[] (tool results are not user messages)
    pendingUserTs = new Date(event.timestamp).getTime();
    return false;
  }

  if (event.type !== 'assistant' || !event.usage) return false;

  const key = event.messageId || event.uuid;
  if (!key) return false;

  const usage = normalizeUsage(event.usage);
  const model = normalizeModelName(event.model || currentModel || 'unknown');
  const tsMs = new Date(event.timestamp).getTime();
  const detail = calculateCostDetail(
    model,
    usage,
    Number.isFinite(tsMs) ? tsMs : Date.now(),
    currentConfig.customModels,
  );
  const costCNY = detail.known ? convertCurrency(detail.amount, detail.currency, 'CNY') : 0;
  currentModel = model;

  const existingIdx = messageIndexByKey.get(key);
  if (existingIdx !== undefined) {
    // Another streaming snapshot of the same API response. Replace it in
    // place (never add a second message); later lines usually carry more
    // complete output tokens, but a trailing placeholder must not win.
    const old = messages[existingIdx];
    const oldUsage = {
      inputTokens: old.inputTokens,
      cacheReadTokens: old.cacheReadTokens,
      cacheCreationTokens: old.cacheCreationTokens,
      outputTokens: old.outputTokens,
    };
    if (!isBetterSnapshot(usage, oldUsage)) return false;

    const oldTotal = oldUsage.inputTokens + oldUsage.cacheReadTokens
      + oldUsage.cacheCreationTokens + oldUsage.outputTokens;
    const newTotal = usage.inputTokens + usage.cacheReadTokens
      + usage.cacheCreationTokens + usage.outputTokens;
    cumulativeInput += usage.inputTokens - oldUsage.inputTokens;
    cumulativeCacheRead += usage.cacheReadTokens - oldUsage.cacheReadTokens;
    cumulativeCacheCreation += usage.cacheCreationTokens - oldUsage.cacheCreationTokens;
    cumulativeOutput += usage.outputTokens - oldUsage.outputTokens;
    cumulativeCost += costCNY - old.costCNY;
    turnTokens += newTotal - oldTotal;
    turnCost += costCNY - old.costCNY;
    if (old.costKnown === false) unknownCostMessages = Math.max(0, unknownCostMessages - 1);
    if (!detail.known) unknownCostMessages++;

    messages[existingIdx] = {
      ...old,
      timestamp: event.timestamp,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      model,
      costCNY,
      costNative: detail.amount,
      costCurrency: detail.currency,
      costKnown: detail.known,
      source: fromSubagent ? 'subagent' : 'main',
      agentId: fromSubagent ? agentId : undefined,
      agentLabel: fromSubagent && agentId ? agentId.slice(0, 8) : undefined,
    };
    return true;
  }

  let thinkTime: number | null = null;
  if (!fromSubagent && pendingUserTs !== null) {
    thinkTime = tsMs - pendingUserTs;
    turnAiAccumulatorMs += thinkTime;
    // Measure the next assistant in this turn from this one; tool_results refine it.
    pendingUserTs = tsMs;
  }

  const msg: PerMessageStats = {
    uuid: event.uuid, messageId: key, timestamp: event.timestamp, isUserMessage: false,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens,
    model, costCNY, costNative: detail.amount, costCurrency: detail.currency,
    costKnown: detail.known, thinkingTimeMs: thinkTime,
    turnAiTimeMs: turnAiAccumulatorMs,
    source: fromSubagent ? 'subagent' : 'main',
    agentId: fromSubagent ? agentId : undefined,
    agentLabel: fromSubagent && agentId ? agentId.slice(0, 8) : undefined,
  };

  messageIndexByKey.set(key, messages.length);
  messages.push(msg);
  cumulativeInput += usage.inputTokens;
  cumulativeOutput += usage.outputTokens;
  cumulativeCacheRead += usage.cacheReadTokens;
  cumulativeCacheCreation += usage.cacheCreationTokens;
  cumulativeCost += costCNY;
  turnTokens += usage.inputTokens + usage.outputTokens
    + usage.cacheReadTokens + usage.cacheCreationTokens;
  turnCost += costCNY;
  if (!detail.known) unknownCostMessages++;
  messageCount++;
  return true;
}

/** Subagent files are named agent-<id>.jsonl; journal.jsonl has no usage. */
function agentIdFromFile(file: string): string | undefined {
  const base = path.basename(file, '.jsonl');
  return base.startsWith('agent-') ? base.slice('agent-'.length) : undefined;
}

/**
 * Tail every JSONL file under <project>/<sessionId>/subagents/.
 * Returns true when any event changed the live state.
 */
function readSubagentEvents(sessionId: string, mainTranscriptPath: string, canReset = true): boolean {
  const root = path.join(path.dirname(mainTranscriptPath), sessionId, 'subagents');
  const files: string[] = [];
  collectJsonlFiles(root, files, 0);
  if (files.length === 0) return false;

  const present = new Set(files);
  for (const file of Array.from(subagentTailers.keys())) {
    if (!present.has(file)) subagentTailers.delete(file);
  }

  let changed = false;
  for (const file of files.sort()) {
    let tailer = subagentTailers.get(file);
    if (!tailer) {
      tailer = new TranscriptTailer();
      subagentTailers.set(file, tailer);
    }
    const result = tailer.read(file);
    if (result.missing) continue;
    if (result.truncated) {
      if (!canReset) {
        console.warn(`[TokenMonitor] Subagent transcript rewritten repeatedly: ${file}`);
        continue;
      }
      // Replaying only this file would double-count the earlier content, so
      // rebuild the whole live session from scratch.
      console.log('[TokenMonitor] Subagent transcript truncated — replaying session');
      resetSessionData();
      const replay = mainTailer.read(mainTranscriptPath);
      let replayed = false;
      for (const event of replay.events) {
        if (processEvent(event, false)) replayed = true;
      }
      if (readSubagentEvents(sessionId, mainTranscriptPath, false)) replayed = true;
      return replayed;
    }
    for (const event of result.events) {
      if (processEvent(event, true, agentIdFromFile(file))) changed = true;
    }
  }
  return changed;
}

/** Recursively collect .jsonl files (bounded depth). */
function collectJsonlFiles(dir: string, out: string[], depth: number): void {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

// ─── Status bar ───────────────────────────────────────────────
function updateStatusBar(): void {
  if (!currentSessionId || messageCount === 0) {
    statusBarItem.text = `$(pulse) ${t('statusBar.idle')}`;
    statusBarItem.tooltip = new vscode.MarkdownString(
      `**${t('statusBar.noData')}**\n\n${t('panel.noSessionHint')}`
    );
    statusBarItem.backgroundColor = undefined;
    return;
  }

  const totalTokens = cumulativeInput + cumulativeCacheRead + cumulativeCacheCreation + cumulativeOutput;
  const lastAsst = findLast(messages, m => !m.isUserMessage);
  const shortTitle = currentTitle.length > 8 ? currentTitle.slice(0, 8) + '…' : currentTitle;
  const currency = currentConfig.resolvedCurrency;
  const displayCumulativeCost = costInDisplayCurrency(cumulativeCost, currency);
  const unknownMark = unknownCostMessages > 0 ? '?' : '';

  // Compact mode: only title + cumulative
  if (currentConfig.compactMode) {
    statusBarItem.text = `$(pulse) ${shortTitle} | ${abbreviateTokens(totalTokens)} ${formatCost(displayCumulativeCost, currency)}${unknownMark}`;
  } else {
    const parts: string[] = [shortTitle];
    if (currentConfig.showModelName) {
      parts.push(currentModel);
    }
    parts.push(`${t('statusBar.turnAiTime')}${formatThinkTime(turnAiAccumulatorMs)}`);
    parts.push(`${abbreviateTokens(turnTokens)} ${formatCost(costInDisplayCurrency(turnCost, currency), currency)}${unknownMark}`);
    parts.push(`${t('statusBar.cumulative')}${abbreviateTokens(totalTokens)} ${formatCost(displayCumulativeCost, currency)}${unknownMark}`);
    statusBarItem.text = `$(pulse) ${parts.join(' | ')}`;
  }

  // Budget warning
  if (currentConfig.budgetWarning > 0 && displayCumulativeCost >= currentConfig.budgetWarning) {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    if (!budgetWarned) {
      budgetWarned = true;
      vscode.window.showWarningMessage(
        `${t('budget.warningTitle')}: ${t('budget.warningBody', { '0': formatCost(displayCumulativeCost, currency) })}`
      );
    }
  } else {
    statusBarItem.backgroundColor = undefined;
    budgetWarned = false;
  }

  // Tooltip
  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  md.isTrusted = false;
  md.appendMarkdown(`### \u{1F4CA} ${escapeMd(currentTitle)}\n\n`);
  md.appendMarkdown(`*${t('tooltip.lastModel')}: ${escapeMd(currentModel)}*\n\n`);

  // ── Last message section ──
  if (lastAsst) {
    const displayLastCost = costInDisplayCurrency(lastAsst.costCNY, currency);
    const lastTotalInput = lastAsst.inputTokens + lastAsst.cacheReadTokens;
    const lastHitRate = calcHitRate(lastAsst.cacheReadTokens, lastTotalInput);
    const timeFmt = formatTime(new Date(lastAsst.timestamp).getTime(), currentConfig.resolvedLanguage);

    md.appendMarkdown(`**${t('tooltip.lastMsg')}** \`${timeFmt}\`\n\n`);
    md.appendMarkdown(`${t('tooltip.totalInput')}  \n  **${lastTotalInput.toLocaleString()}**\n\n`);
    md.appendMarkdown(`${t('tooltip.cacheHit')}  \n  ${lastAsst.cacheReadTokens.toLocaleString()} (${lastHitRate})\n\n`);
    md.appendMarkdown(`${t('tooltip.cacheMiss')}  \n  ${lastAsst.inputTokens.toLocaleString()}\n\n`);
    md.appendMarkdown(`${t('tooltip.output')}  \n  ${lastAsst.outputTokens.toLocaleString()}\n\n`);
    md.appendMarkdown(`${t('tooltip.cost')}  \n  ${formatCost(displayLastCost, currency)}${lastAsst.costKnown === false ? ' (?)' : ''}\n\n`);
    md.appendMarkdown(`**${t('tooltip.turnAiTime')}**  \n  ${formatThinkTime(turnAiAccumulatorMs)}\n\n`);
  } else {
    md.appendMarkdown(`*${t('tooltip.noMessages')}*\n\n`);
  }

  md.appendMarkdown(`---\n\n**${t('tooltip.sessionTotal')}**\n\n`);
  const cumTotalInput = cumulativeInput + cumulativeCacheRead;
  const cumHitRate = calcHitRate(cumulativeCacheRead, cumTotalInput);
  md.appendMarkdown(`${t('tooltip.totalInput')}  \n  **${cumTotalInput.toLocaleString()}**\n\n`);
  md.appendMarkdown(`${t('tooltip.cacheHit')}  \n  ${cumulativeCacheRead.toLocaleString()} (${cumHitRate})\n\n`);
  md.appendMarkdown(`${t('tooltip.cacheMiss')}  \n  ${cumulativeInput.toLocaleString()}\n\n`);
  md.appendMarkdown(`${t('tooltip.output')}  \n  ${cumulativeOutput.toLocaleString()}\n\n`);
  md.appendMarkdown(`${t('tooltip.cost')}  \n  ${formatCost(displayCumulativeCost, currency)}\n\n`);
  md.appendMarkdown(`${t('tooltip.messages')}  \n  ${messageCount}\n\n`);

  // Exchange rate — only show when display currency differs from the model's native currency
  const rateTo = currency;
  const currentPricing = resolvePricing(currentModel, currentConfig.customModels);
  const rateFrom = currentPricing?.currency;
  if (rateFrom && rateTo !== rateFrom) {
    const backConvert = convertCurrency(1, rateTo as Currency, rateFrom);
    const rate = (1 / backConvert).toFixed(2);
    md.appendMarkdown(`---\n\n*1 ${rateFrom} ≈ ${rate} ${rateTo} · ${formatRatesAge()}*`);
  }

  statusBarItem.tooltip = md;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Convert a cost stored in CNY (all live totals are normalized to CNY at
 * calculation time) to the user's display currency.
 */
function costInDisplayCurrency(cnyCost: number, targetCurrency: string): number {
  if (!Number.isFinite(cnyCost)) return 0;
  if (!targetCurrency || targetCurrency === 'CNY') return cnyCost;
  const converted = convertCurrency(cnyCost, 'CNY', targetCurrency as Currency);
  return Number.isFinite(converted) ? converted : cnyCost;
}

/** Save the current in-memory session state to the persistent index. */
function upsertCurrentToIndex(cwd: string): void {
  if (!currentSessionId || messageCount === 0) return;
  const primaryModel = computePrimaryModel();
  let fileSize = 0;
  let fileMtimeMs = 0;
  try {
    const stat = fs.statSync(lastTranscriptPath);
    fileSize = stat.size;
    fileMtimeMs = stat.mtimeMs;
  } catch { /* transcript may be gone */ }
  SessionStore.upsertSession(currentSessionId, {
    sessionId: currentSessionId,
    title: currentTitle || currentSessionId.slice(0, 8) + '...',
    cwd,
    startedAt: messages.length > 0 ? new Date(messages[0].timestamp).getTime() : Date.now(),
    lastUpdatedAt: Date.now(),
    messageCount,
    totalInputTokens: cumulativeInput,          // cache-miss only
    totalOutputTokens: cumulativeOutput,
    totalCacheHitTokens: cumulativeCacheRead,
    totalCacheMissTokens: 0, // cache-miss input is already totalInputTokens (schema compat)
    totalCacheCreationTokens: cumulativeCacheCreation,
    totalCostCNY: cumulativeCost,
    primaryModel,
    fileSize,
    fileMtimeMs,
  });
}

/**
 * Keep the index fresh. Sessions without subagent transcripts can be updated
 * from the live state cheaply; sessions with subagents need a full rescan so
 * their tokens are not silently dropped from history.
 */
function persistCurrentSession(cwd: string): void {
  const nestedDir = path.join(path.dirname(lastTranscriptPath), currentSessionId, 'subagents');
  if (fs.existsSync(nestedDir)) {
    scheduleIndexRefresh();
    return;
  }
  upsertCurrentToIndex(cwd);
}

function scheduleIndexRefresh(): void {
  if (indexRefreshTimer) return;
  indexRefreshTimer = setTimeout(() => {
    indexRefreshTimer = null;
    try {
      SessionStore.scanAndIndex(currentConfig.customModels);
    } catch (err) {
      console.error('[TokenMonitor] index refresh error:', err);
    }
  }, 15000);
}

function computePrimaryModel(): string {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (!m.isUserMessage && m.model) {
      counts.set(m.model, (counts.get(m.model) || 0) + 1);
    }
  }
  let best = 'unknown';
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) { bestCount = count; best = model; }
  }
  return best;
}

/** Clear everything derived from the transcript, keeping session identity. */
/** Clear everything derived from transcript events, keeping tailer positions. */
function resetAccumulatorState(): void {
  currentModel = 'unknown';
  cumulativeInput = 0; cumulativeOutput = 0; cumulativeCacheRead = 0;
  cumulativeCacheCreation = 0; cumulativeCost = 0;
  messageCount = 0;
  messages = [];
  messageIndexByKey.clear();
  unknownCostMessages = 0;
  pendingUserTs = null;
  turnAiAccumulatorMs = 0;
  turnTokens = 0;
  turnCost = 0;
}

/** Clear accumulator state and forget all file positions (new session / refresh). */
function resetSessionData(): void {
  resetAccumulatorState();
  mainTailer.reset();
  subagentTailers.clear();
}

function resetState(): void {
  currentSessionId = ''; currentTitle = ''; currentModel = 'unknown';
  resetSessionData();
  lastTranscriptPath = '';
  activeSessionOverride = null;
  budgetWarned = false;
}

function findLast<T>(arr: T[], pred: (item: T) => boolean): T | null {
  for (let i = arr.length - 1; i >= 0; i--) { if (pred(arr[i])) return arr[i]; }
  return null;
}

function escapeMd(text: string): string { return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&'); }

function formatThinkTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

/** Format a timestamp for display using the configured language's locale. */
function formatTime(epochMs: number, lang: string): string {
  try {
    const locale = lang === 'zh-CN' ? 'zh-CN' : lang === 'ja' ? 'ja-JP' : lang === 'ko' ? 'ko-KR' : 'en-US';
    return new Date(epochMs).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return new Date(epochMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}

/** Calculate cache hit rate as percentage string. */
function calcHitRate(hit: number, total: number): string {
  if (total === 0) return '—';
  return ((hit / total) * 100).toFixed(1) + '%';
}

/** Format exchange rate age for display. */
function formatRatesAge(): string {
  const ts = getRatesUpdatedAt();
  if (!ts) return t('rates.unknown');
  if (ts === 1) return t('rates.builtin'); // Built-in, never fetched from remote
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return mins <= 1 ? t('rates.justNow') : t('rates.minutesAgo', { '0': String(mins) });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('rates.hoursAgo', { '0': String(hours) });
  const days = Math.floor(hours / 24);
  return t('rates.daysAgo', { '0': String(days) });
}

// ─── Claude-readable output ───────────────────────────────────
function writeClaudeReadable(): void {
  try { fs.mkdirSync(tokenMonitorDir(), { recursive: true }); } catch { /* */ }
  const totalTokens = cumulativeInput + cumulativeCacheRead + cumulativeCacheCreation + cumulativeOutput;
  const lastAsst = findLast(messages, m => !m.isUserMessage);
  const lastUser = findLast(messages, m => m.isUserMessage);
  const data: ClaudeReadableData = {
    sessionId: currentSessionId, title: currentTitle, model: currentModel, active: true,
    cumulative: { inputTokens: cumulativeInput, cacheReadTokens: cumulativeCacheRead, outputTokens: cumulativeOutput, messageCount, totalCostCNY: cumulativeCost, totalTokens },
    lastMessage: lastAsst ? { uuid: lastAsst.uuid, timestamp: lastAsst.timestamp, type: 'assistant', model: lastAsst.model, inputTokens: lastAsst.inputTokens, cacheReadTokens: lastAsst.cacheReadTokens, outputTokens: lastAsst.outputTokens, costCNY: lastAsst.costCNY, thinkingTimeMs: lastAsst.thinkingTimeMs } : null,
    lastUserMessage: lastUser ? { uuid: lastUser.uuid, timestamp: lastUser.timestamp, thinkingTimeMs: lastAsst?.thinkingTimeMs ?? null } : null,
    updatedAt: new Date().toISOString(),
  };
  try { fs.writeFileSync(path.join(tokenMonitorDir(), 'current-session.json'), JSON.stringify(data, null, 2), 'utf-8'); } catch { /* */ }
}

// ─── Webview filter handlers (v0.12.0) ─────────────────────────

function handleSetTimeRange(timeRange: TimeRange, postMsg?: (msg: any) => void): void {
  const now = Date.now();
  let startMs = 0;
  const d = new Date();

  switch (timeRange) {
    case 'daily':
      d.setHours(0, 0, 0, 0);
      startMs = d.getTime();
      break;
    case 'weekly': {
      const dayOfWeek = d.getDay();
      const diff = d.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Monday start
      d.setDate(diff);
      d.setHours(0, 0, 0, 0);
      startMs = d.getTime();
      break;
    }
    case 'monthly':
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      startMs = d.getTime();
      break;
    case 'yearly':
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      startMs = d.getTime();
      break;
    case 'all':
      startMs = 0;
      break;
    default:
      // 'current' — handled client-side with existing fullUpdate data
      return;
  }

  const sessions = SessionStore.getSessionsInRange(startMs, now);
  const agg = buildAggregatedData(timeRange, sessions, now, startMs);

  if (postMsg) {
    postMsg({
      type: 'aggregatedData',
      data: agg,
      lang: currentConfig.resolvedLanguage,
      currency: currentConfig.resolvedCurrency,
      i18n: detailPanel.getTranslations(),
    });
  } else {
    detailPanel.pushAggregatedData(agg);
  }
}

function handleSelectSession(sessionId: string, postMsg?: (msg: any) => void): void {
  // Find the session in the index
  const entry = SessionStore.getAllSessions().find(s => s.sessionId === sessionId);
  if (!entry) return;

  // Parse the main transcript plus subagent transcripts and build PanelData
  const tp = path.join(claudeDir(), 'projects', encodeProjectPath(entry.cwd), sessionId + '.jsonl');
  if (!fs.existsSync(tp)) return;

  const msgs = parseSessionTranscripts(entry.cwd, sessionId);
  // Totals and the per-message table now both include subagent transcripts.
  const totalTokens = entry.totalInputTokens + entry.totalOutputTokens
    + entry.totalCacheHitTokens + (entry.totalCacheCreationTokens || 0);
  // Price the freshly parsed messages rather than trusting the cached total:
  // the index entry may predate the current price catalog.
  const freshCostCNY = msgs.reduce((sum, m) => (m.isUserMessage ? sum : sum + (m.costCNY || 0)), 0);
  const displayCost = costInDisplayCurrency(
    msgs.some(m => !m.isUserMessage) ? freshCostCNY : entry.totalCostCNY,
    currentConfig.resolvedCurrency,
  );
  const lastAsst = findLast(msgs, m => !m.isUserMessage && (m.turnAiTimeMs ?? 0) > 0)
    || findLast(msgs, m => !m.isUserMessage);
  const modelStats = buildModelStatsFromMessages(msgs);

  const sessionData: PanelData = {
    sessionId,
    title: entry.title,
    model: entry.primaryModel,
    isActive: false,
    cumulativeInputTokens: entry.totalInputTokens,
    cumulativeOutputTokens: entry.totalOutputTokens,
    cumulativeCacheReadTokens: entry.totalCacheHitTokens,
    cumulativeCostCNY: displayCost,
    totalTokens,
    messageCount: entry.messageCount,
    messages: toDisplayMessages(msgs),
    agentStats: buildPanelAgentStats(msgs),
    lastUpdatedAt: new Date(entry.lastUpdatedAt).toISOString(),
    turnAiTimeMs: lastAsst?.turnAiTimeMs ?? 0,
    lang: currentConfig.resolvedLanguage,
    currency: currentConfig.resolvedCurrency,
    pollIntervalMs: currentConfig.pollIntervalMs,
    modelStats,
  };

  if (postMsg) {
    postMsg({
      type: 'sessionDetail',
      session: sessionData,
      lang: sessionData.lang || 'en',
      currency: sessionData.currency || 'USD',
      i18n: detailPanel.getTranslations(),
    });
  } else {
    detailPanel.pushSessionDetail(sessionData);
  }
}

function handleClearSessionSelection(): void {
  // Return to current session view — just push the latest data
  pushToWebview();
}

/** Build AggregatedData from sessions, filtering messages by timestamp range. */
function buildAggregatedData(timeRange: TimeRange, sessions: SessionIndexEntry[], endMs: number, startMs: number): AggregatedData {
  let totalTokens = 0, totalCostCNY = 0, inputTokens = 0, outputTokens = 0,
    cacheHits = 0, cacheMiss = 0, messageCount = 0;

  const allFilteredMsgs: PerMessageStats[] = [];
  const activeSessions: SessionIndexEntry[] = []; // sessions with ≥1 message in range

  for (const s of sessions) {
    const msgs = parseSessionTranscripts(s.cwd, s.sessionId);
    if (msgs.length === 0) continue;

    // Filter messages whose timestamp falls within [startMs, endMs]
    const filtered = msgs.filter(m => {
      const ts = new Date(m.timestamp).getTime();
      return ts >= startMs && ts <= endMs;
    });

    const assistantMsgs = filtered.filter(m => !m.isUserMessage);
    if (assistantMsgs.length === 0) continue; // no assistant messages in range → skip session

    activeSessions.push({
      ...s,
      totalCostCNY: costInDisplayCurrency(s.totalCostCNY, currentConfig.resolvedCurrency),
    });

    for (const m of assistantMsgs) {
      totalTokens += m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
      totalCostCNY += m.costCNY;
      inputTokens += m.inputTokens + m.cacheReadTokens;
      outputTokens += m.outputTokens;
      cacheHits += m.cacheReadTokens;
      cacheMiss += m.inputTokens;
      messageCount++;
    }

    allFilteredMsgs.push(...assistantMsgs);
  }

  const totalInput = inputTokens;
  const hitRate = totalInput > 0 ? (cacheHits / totalInput * 100) : 0;
  const displayCost = costInDisplayCurrency(totalCostCNY, currentConfig.resolvedCurrency);
  const modelStats = buildModelStatsFromMessages(allFilteredMsgs);

  return {
    timeRange,
    sessions: activeSessions,
    totalTokens,
    totalCost: displayCost,
    totalCostCNY,
    inputTokens,
    outputTokens,
    cacheHits,
    cacheMiss,
    hitRate: Math.round(hitRate * 10) / 10,
    messageCount,
    sessionCount: activeSessions.length,
    modelStats,
  };
}

/** Parse a transcript file with mtime-based caching. */
function parseFullTranscriptCached(filePath: string, source?: TranscriptSource): PerMessageStats[] {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { return []; }

  const cached = transcriptCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.messages;
  }

  const messages = parseFullTranscriptRaw(filePath, source);
  transcriptCache.set(filePath, { mtimeMs, messages });
  return messages;
}

/** Parse an entire transcript file into PerMessageStats[] (raw, uncached). */
function parseFullTranscriptRaw(filePath: string, source?: TranscriptSource): PerMessageStats[] {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  return replayTranscriptLines(raw.split('\n'), currentConfig.customModels, source);
}

/**
 * Parse everything that belongs to one session: the main transcript plus every
 * JSONL file under <sessionId>/subagents/. Subagent usage is part of the bill,
 * so historical and aggregated views must include it (the live poller already
 * tails these files).
 */
function parseSessionTranscripts(cwd: string, sessionId: string): PerMessageStats[] {
  const mainPath = getTranscriptPath(cwd, sessionId);
  const files = [mainPath];
  const nestedDir = path.join(path.dirname(mainPath), sessionId, 'subagents');
  collectJsonlFiles(nestedDir, files, 0);

  const all: PerMessageStats[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const isMain = i === 0;
    const agentId = isMain ? undefined : agentIdFromFile(file);
    const msgs = parseFullTranscriptCached(
      file,
      isMain
        ? { kind: 'main' }
        : { kind: 'subagent', agentId, agentLabel: agentId ? agentId.slice(0, 8) : undefined },
    );
    if (msgs.length > 0) all.push(...msgs);
  }
  all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return all;
}

/** Build model stats from a PerMessageStats array (for session detail views). */
function buildModelStatsFromMessages(msgs: PerMessageStats[]): ModelStatEntry[] {
  const map = new Map<string, { cost: number; tokens: number; inputTokens: number; cacheHits: number; cacheMiss: number; outputTokens: number }>();
  for (const m of msgs) {
    if (m.isUserMessage) continue;
    const model = m.model;
    if (!model || model === 'unknown' || model === '<synthetic>' || model.startsWith('<')) continue;
    const entry = map.get(model) || { cost: 0, tokens: 0, inputTokens: 0, cacheHits: 0, cacheMiss: 0, outputTokens: 0 };
    const displayCost = costInDisplayCurrency(m.costCNY, currentConfig.resolvedCurrency);
    entry.cost += displayCost;
    entry.inputTokens += m.inputTokens + m.cacheReadTokens;
    entry.cacheHits += m.cacheReadTokens;
    entry.cacheMiss += m.inputTokens;
    entry.outputTokens += m.outputTokens;
    entry.tokens += m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens + m.outputTokens;
    map.set(model, entry);
  }
  return Array.from(map.entries()).map(([model, v]) => ({ model, ...v }));
}

function buildModelStats(): Array<{ model: string; cost: number; tokens: number; inputTokens: number; cacheHits: number; cacheMiss: number; outputTokens: number }> {
  return buildModelStatsFromMessages(messages);
}

/** Copy the last 200 messages (chronological) and attach the display-currency cost. */
function toDisplayMessages(list: PerMessageStats[]): PerMessageStats[] {
  const currency = currentConfig.resolvedCurrency;
  return recentMessages(list, 200).map(m => ({
    ...m,
    costDisplay: costInDisplayCurrency(m.costCNY, currency),
  }));
}

/** Main/subagent split for the panel — always computed from the full message list. */
function buildPanelAgentStats(list: PerMessageStats[]) {
  const currency = currentConfig.resolvedCurrency;
  return buildAgentStats(list, cny => costInDisplayCurrency(cny, currency));
}

function pushToWebview(): void {
  if (!detailPanel) { console.error('[TokenMonitor] pushToWebview: detailPanel is null'); return; }
  const totalTokens = cumulativeInput + cumulativeCacheRead + cumulativeCacheCreation + cumulativeOutput;
  const currency = currentConfig.resolvedCurrency;
  const displayCumulativeCost = costInDisplayCurrency(cumulativeCost, currency);
  detailPanel.pushData({
    sessionId: currentSessionId,
    title: currentTitle || currentSessionId.slice(0, 8) + '...',
    model: currentModel, isActive: true,
    cumulativeInputTokens: cumulativeInput, cumulativeOutputTokens: cumulativeOutput,
    cumulativeCacheReadTokens: cumulativeCacheRead, cumulativeCostCNY: displayCumulativeCost,
    totalTokens, messageCount,
    messages: toDisplayMessages(messages),
    agentStats: buildPanelAgentStats(messages),
    lastUpdatedAt: new Date().toISOString(),
    turnAiTimeMs: turnAiAccumulatorMs,
    lang: currentConfig.resolvedLanguage,
    currency: currency,
    pollIntervalMs: currentConfig.pollIntervalMs,
    modelStats: buildModelStats(),
    sessionList: SessionStore.getSessionList(),
  } as any);
}

function pushToWebviewPanel(panel: vscode.WebviewPanel): void {
  const totalTokens = cumulativeInput + cumulativeCacheRead + cumulativeCacheCreation + cumulativeOutput;
  const currency = currentConfig.resolvedCurrency;
  const displayCumulativeCost = costInDisplayCurrency(cumulativeCost, currency);
  panel.webview.postMessage({
    type: 'fullUpdate',
    lang: currentConfig.resolvedLanguage,
    currency: currency,
    i18n: detailPanel.getTranslations(),
    session: {
      sessionId: currentSessionId,
      title: currentTitle || currentSessionId.slice(0, 8) + '...',
      model: currentModel, isActive: true,
      cumulativeInputTokens: cumulativeInput, cumulativeOutputTokens: cumulativeOutput,
      cumulativeCacheReadTokens: cumulativeCacheRead, cumulativeCostCNY: displayCumulativeCost,
      totalTokens, messageCount,
      messages: toDisplayMessages(messages),
      agentStats: buildPanelAgentStats(messages),
      lastUpdatedAt: new Date().toISOString(),
      turnAiTimeMs: turnAiAccumulatorMs,
      lang: currentConfig.resolvedLanguage,
      currency: currency,
      pollIntervalMs: currentConfig.pollIntervalMs,
      modelStats: buildModelStats(),
    },
  });
  // Also push session list for the dropdown
  try {
    panel.webview.postMessage({ type: 'sessionList', sessions: SessionStore.getSessionList() });
  } catch { /* */ }
}

// ─── Explicit session selection ─────────────────────────────
async function selectSessionToMonitor(): Promise<void> {
  const entries = SessionStore.getAllSessions();
  const live = scanSessions();
  const liveIds = new Set(live.map(s => s.sessionId));
  const zh = currentConfig.resolvedLanguage.startsWith('zh');

  const items: Array<vscode.QuickPickItem & { sessionId?: string; cwd?: string; clear?: boolean }> = [
    {
      label: zh ? '$(refresh) 跟随最近活跃的会话' : '$(refresh) Follow the most recently active session',
      description: '',
      clear: true,
    },
  ];

  for (const entry of entries) {
    items.push({
      label: entry.title || entry.sessionId.slice(0, 8),
      description: `${entry.cwd}${liveIds.has(entry.sessionId) ? (zh ? ' · 运行中' : ' · live') : ''}`,
      detail: `${new Date(entry.lastUpdatedAt).toLocaleString()} · ${entry.messageCount} msgs · ${entry.primaryModel}`,
      sessionId: entry.sessionId,
      cwd: entry.cwd,
    });
  }

  const indexed = new Set(entries.map(e => e.sessionId));
  for (const session of live) {
    if (indexed.has(session.sessionId)) continue;
    items.push({
      label: session.sessionId.slice(0, 8),
      description: `${session.cwd} · ${zh ? '运行中' : 'live'}`,
      sessionId: session.sessionId,
      cwd: session.cwd,
    });
  }

  if (items.length === 1) {
    vscode.window.showInformationMessage(zh ? '还没有可选择的会话。' : 'No sessions to select yet.');
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: zh ? '选择要监视的 Claude Code 会话' : 'Select a Claude Code session to monitor',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  if (picked.clear) {
    activeSessionOverride = null;
    currentSessionId = ''; // force the poller back to the newest session
    poll();
    return;
  }

  if (!picked.sessionId || !picked.cwd) return;
  const tp = path.join(claudeDir(), 'projects', encodeProjectPath(picked.cwd), picked.sessionId + '.jsonl');
  if (!fs.existsSync(tp)) {
    vscode.window.showWarningMessage(
      zh ? '该会话的转录文件已不存在。' : 'That session transcript no longer exists.'
    );
    return;
  }
  activeSessionOverride = { sessionId: picked.sessionId, cwd: picked.cwd };
  poll();
}

// ─── Pricing refresh ───────────────────────────────────────
const PRICING_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
let pricingAutoUpdateActive = false;

/**
 * Keep the catalog and exchange rates fresh while the editor stays open.
 * The catalog itself is cached for 24h inside checkForUpdates(), so the 6h
 * tick only costs a rate fetch on most runs.
 */
function startPricingRefresh(): void {
  const enabled = vscode.workspace
    .getConfiguration('claudeTokenMonitor')
    .get<boolean>('pricing.autoUpdate', true);

  if (!enabled) {
    if (pricingRefreshTimer) { clearInterval(pricingRefreshTimer); pricingRefreshTimer = null; }
    pricingAutoUpdateActive = false;
    return;
  }
  if (pricingAutoUpdateActive && pricingRefreshTimer) return;

  pricingAutoUpdateActive = true;
  checkForUpdates(currentConfig.pricingUpdateUrl || undefined)
    .catch((err) => console.warn('[TokenMonitor] Pricing refresh failed:', err));
  pricingRefreshTimer = setInterval(() => {
    checkForUpdates(currentConfig.pricingUpdateUrl || undefined)
      .catch((err) => console.warn('[TokenMonitor] Pricing refresh failed:', err));
  }, PRICING_REFRESH_INTERVAL_MS);
}

// ─── Config refresh ─────────────────────────────────────────
function refreshConfig(): void {
  const oldLang = currentConfig.resolvedLanguage;
  const oldCurrency = currentConfig.resolvedCurrency;
  const oldPollMs = currentConfig.pollIntervalMs;
  currentConfig = getConfig();

  // Language change → rebuild i18n + webview HTML
  if (currentConfig.resolvedLanguage !== oldLang) {
    initI18n(currentConfig.language);
    detailPanel.refreshHtml();
    // Delay push until webview finishes reloading (otherwise ready handler races)
    setTimeout(() => pushToWebview(), 300);
  }

  // Currency change → force re-fetch pricing for fresh rates
  if (currentConfig.resolvedCurrency !== oldCurrency) {
    checkForUpdates(currentConfig.pricingUpdateUrl || undefined, true);
  }

  // Poll interval change → restart timers
  if (currentConfig.pollIntervalMs !== oldPollMs) {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = setInterval(poll, currentConfig.pollIntervalMs);
    }
    if (standaloneSyncTimer) {
      clearInterval(standaloneSyncTimer);
      standaloneSyncTimer = setInterval(() => {
        if (standalonePanel && standalonePanel.visible) pushToWebviewPanel(standalonePanel);
      }, currentConfig.pollIntervalMs);
    }
  }

  // Always refresh display after config change
  startPricingRefresh();
  updateStatusBar();
  pushToWebview();
}

// ─── Standalone dashboard panel ───────────────────────────────
function openStandalonePanel(): void {
  if (standalonePanel) {
    standalonePanel.reveal(vscode.ViewColumn.Active);
    pushToWebviewPanel(standalonePanel);
    try {
      standalonePanel.webview.postMessage({ type: 'sessionList', sessions: SessionStore.getSessionList() });
    } catch { /* panel may be disposing */ }
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'claudeTokenMonitorDetail',
    t('panel.title'),
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  standalonePanel = panel;
  panel.webview.html = detailPanel.getHtml();

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'ready') {
      pushToWebviewPanel(panel);
      try {
        panel.webview.postMessage({ type: 'sessionList', sessions: SessionStore.getSessionList() });
      } catch { /* */ }
    } else if (msg.type === 'openSettings') {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + extensionId);
    } else if (msg.type === 'setTimeRange') {
      handleSetTimeRange(msg.timeRange as TimeRange, panel.webview.postMessage.bind(panel.webview));
    } else if (msg.type === 'selectSession') {
      handleSelectSession(msg.sessionId!, panel.webview.postMessage.bind(panel.webview));
    } else if (msg.type === 'clearSessionSelection') {
      handleClearSessionSelection();
      pushToWebviewPanel(panel);
    }
  });

  panel.onDidDispose(() => {
    if (standaloneSyncTimer) {
      clearInterval(standaloneSyncTimer);
      standaloneSyncTimer = null;
    }
    if (standalonePanel === panel) standalonePanel = null;
  });

  pushToWebviewPanel(panel);

  standaloneSyncTimer = setInterval(() => {
    if (standalonePanel && standalonePanel.visible) {
      pushToWebviewPanel(standalonePanel);
    }
  }, currentConfig.pollIntervalMs);
}

// ─── Activation ───────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
  // Store the actual extension ID (publisher.name from package.json)
  extensionId = context.extension.id;

  // Load config + init i18n
  currentConfig = getConfig();
  initI18n(currentConfig.language, context.extensionPath);

  // Load the catalog shipped inside the VSIX first — offline must always work.
  loadBundledPricing(context.extensionPath);

  // Async: scan and index existing session transcripts for cross-session views
  setTimeout(() => {
    try {
      SessionStore.scanAndIndex(currentConfig.customModels);
      console.log('[TokenMonitor] Session index scanned (' + Object.keys(SessionStore.loadIndex().sessions).length + ' sessions)');
    } catch (err) { console.error('[TokenMonitor] scanAndIndex error:', err); }
  }, 800);

  // Async: check for pricing/rates updates (non-blocking) and keep them fresh
  startPricingRefresh();

  console.log(`[TokenMonitor] v1.3.0 activating (${currentConfig.resolvedLanguage}/${currentConfig.resolvedCurrency})...`);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = 'Claude Code Token Monitor';
  statusBarItem.command = 'claudeCodeTokenMonitor.showDetailPanel';
  statusBarItem.text = `$(pulse) ${t('statusBar.idle')}`;
  statusBarItem.tooltip = new vscode.MarkdownString(`**${t('statusBar.noData')}**`);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  detailPanel = new DetailPanel(() => ({
    t,
    lang: currentConfig.resolvedLanguage,
    currency: currentConfig.resolvedCurrency,
    isRTL: isRTL(),
  }));
  detailPanel.setFilterMessageHandler((msg) => {
    if (msg.type === 'setTimeRange') handleSetTimeRange(msg.timeRange as TimeRange);
    else if (msg.type === 'selectSession') handleSelectSession(msg.sessionId!);
    else if (msg.type === 'clearSessionSelection') handleClearSessionSelection();
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeCodeTokenMonitor.detailPanel', detailPanel, { webviewOptions: { retainContextWhenHidden: true } })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeTokenMonitor.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + extensionId);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeTokenMonitor.showDetailPanel', () => openStandalonePanel())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeTokenMonitor.selectSession', () => selectSessionToMonitor())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeTokenMonitor.refresh', () => {
      resetSessionData();
      poll();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeTokenMonitor.showLastMessageCost', () => {
      const lastAsst = findLast(messages, m => !m.isUserMessage);
      if (!lastAsst) { vscode.window.showInformationMessage(t('command.noMessages')); return; }
      const displayCost = costInDisplayCurrency(lastAsst.costCNY, currentConfig.resolvedCurrency);
      const thinkStr = lastAsst.thinkingTimeMs ? ` | ${t('command.thinkingTime')}: ${formatThinkTime(lastAsst.thinkingTimeMs)}` : '';
      vscode.window.showInformationMessage(
        `${t('command.lastMsg')}: +${lastAsst.inputTokens.toLocaleString()} / +${lastAsst.outputTokens.toLocaleString()} / ${formatCost(displayCost, currentConfig.resolvedCurrency)}${thinkStr}`
      );
    })
  );

  // Add custom model (guided)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeTokenMonitor.addCustomModel', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Model name (e.g. "My Custom Model")', placeHolder: 'My Model' });
      if (!name) return;
      const pattern = await vscode.window.showInputBox({ prompt: 'Match pattern (regex to detect model, e.g. "my-model")', placeHolder: 'my-model' });
      if (!pattern) return;
      const currencyPick = await vscode.window.showQuickPick(['USD', 'CNY', 'EUR', 'JPY', 'KRW', 'GBP'], { placeHolder: 'Select currency' });
      if (!currencyPick) return;
      const cacheHitStr = await vscode.window.showInputBox({ prompt: 'Cache hit price per 1M tokens', value: '0' });
      if (cacheHitStr === undefined) return;
      const cacheMissStr = await vscode.window.showInputBox({ prompt: 'Cache miss price per 1M tokens', value: '0' });
      if (cacheMissStr === undefined) return;
      const outputStr = await vscode.window.showInputBox({ prompt: 'Output price per 1M tokens', value: '0' });
      if (outputStr === undefined) return;

      const newModel = { name, matchPattern: pattern, cacheHit: Number(cacheHitStr), cacheMiss: Number(cacheMissStr), output: Number(outputStr), currency: currencyPick };
      const cfg = vscode.workspace.getConfiguration('claudeTokenMonitor');
      const existing = cfg.get<any[]>('customModels') || [];
      existing.push(newModel);
      await cfg.update('customModels', existing, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Custom model "${name}" added.`);
    })
  );

  // Manage custom models (list & delete)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeTokenMonitor.manageCustomModels', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeTokenMonitor');
      const models = cfg.get<any[]>('customModels') || [];
      if (models.length === 0) {
        vscode.window.showInformationMessage('No custom models configured.');
        return;
      }
      const picks = models.map((m, i) => ({ label: `${m.name} (${m.matchPattern})`, description: `${m.currency} · in:${m.cacheMiss}/out:${m.output}`, index: i }));
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a model to remove' });
      if (pick === undefined) return;
      models.splice(pick.index, 1);
      await cfg.update('customModels', models, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Removed "${pick.label}".`);
    })
  );

  // Force refresh pricing
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeTokenMonitor.forceRefreshPricing', async () => {
      vscode.window.showInformationMessage('Refreshing pricing data...');
      await checkForUpdates(currentConfig.pricingUpdateUrl || undefined, true);
      vscode.window.showInformationMessage('Pricing data refreshed.');
    })
  );

  // Configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeTokenMonitor')) {
        refreshConfig();
      }
    })
  );

  // Initial poll
  poll();
  pollTimer = setInterval(poll, currentConfig.pollIntervalMs);

  console.log('[TokenMonitor] Activated.');
}

export function deactivate(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (standaloneSyncTimer) { clearInterval(standaloneSyncTimer); standaloneSyncTimer = null; }
  if (pricingRefreshTimer) { clearInterval(pricingRefreshTimer); pricingRefreshTimer = null; }
  if (indexRefreshTimer) { clearTimeout(indexRefreshTimer); indexRefreshTimer = null; }
  console.log('[TokenMonitor] Deactivated.');
}
