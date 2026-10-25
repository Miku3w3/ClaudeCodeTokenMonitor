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
import {
  pickSessionForTab, pickNewestSession, cleanTabLabel, normalizeTitle, transcriptLabel,
  mayCarryLabel, orderSessionLabels,
  type FollowCandidate, type TabMatch,
} from './core/sessionFollow';
import { claudeDir, tokenMonitorDir, tokenTrackerDir, transcriptPath as getTranscriptPath } from './utils/paths';
import type { Currency, PerMessageStats, SessionPidFile, ClaudeReadableData, TimeRange, AggregatedData, SessionIndexEntry, ModelStatEntry } from './model/types';
import { DetailPanel } from './ui/DetailPanel';
import type { PanelData } from './ui/DetailPanel';
import { t, initI18n, isRTL } from './i18n/index';
import { getConfig } from './config/settings';
import { checkForUpdates, loadBundledPricing } from './model/pricing-fetcher';
import { getRatesUpdatedAt, getRatesSource } from './model/pricing';
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

// Session following. Precedence:
//   1. a session picked from the command palette (until the user moves to
//      another conversation tab),
//   2. the session whose title matches the conversation tab on screen,
//   3. the freshest session in this window's workspace,
//   4. the freshest session anywhere.
// Rules 2–4 live in core/sessionFollow.ts so they can be unit-tested.
let manualSessionOverride: { sessionId: string; cwd: string; label: string } | null = null;
let tabSessionOverride: { sessionId: string; cwd: string } | null = null;
/** The tab on screen is a brand-new conversation with nothing in it yet. */
let tabIdle = false;
/** Last conversation-tab label we acted on. */
let lastTabLabel: string | null = null;
let followRetryTimer: ReturnType<typeof setTimeout> | null = null;
interface SessionTitleEntry { labels: string[]; mtimeMs: number; size: number }
const sessionTitleCache = new Map<string, SessionTitleEntry>();

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
/**
 * How far back a label scan may go.
 *
 * A tab keeps the name it was given, so a long-running conversation's tab
 * label can sit many messages — and many megabytes of tool output — behind the
 * newest message. The shallow scan covers the common case cheaply; the deep
 * scan runs only when the active tab's label did not match anything.
 */
const LABEL_SCAN = {
  shallow: { chunks: 64, labels: 12, titles: 8 },
  deep: { chunks: 512, labels: 200, titles: 24 },
};

/**
 * The labels Claude Code may show on this session's conversation tab: the
 * newest generated title, the titles it replaced, then the newest messages the
 * user actually typed.
 *
 * Claude Code titles a tab with `agentName || customTitle || aiTitle ||
 * firstPrompt`. It writes a `custom-title` + `agent-name` pair whenever the
 * title is set or changed, so a session that has a title never shows a user
 * message on its tab — scanning only for `user` lines made every such title
 * resolve to no session at all. The older titles stay in the list because they
 * are also what the tab showed before it was retitled, and because a title can
 * be reused by another session, where the newer use must win.
 */
function getSessionLabels(s: { cwd: string; sessionId: string }, deep = false): string[] {
  const tp = path.join(claudeDir(), 'projects', encodeProjectPath(s.cwd), s.sessionId + '.jsonl');
  let stat: fs.Stats;
  try { stat = fs.statSync(tp); } catch { return []; }

  const cacheKey = deep ? `deep:${s.sessionId}` : s.sessionId;
  const cached = sessionTitleCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.labels;

  const limits = deep ? LABEL_SCAN.deep : LABEL_SCAN.shallow;
  const userTexts: string[] = [];
  const titles: string[] = [];
  let aiTitle = '';
  let chunksWithoutTitle = 0;
  try {
    // Read backwards in 64KB chunks. Scanning stops as soon as enough recent
    // user messages are found, so quiet sessions cost one chunk. This only
    // runs when a session's transcript changed or a deep scan is requested.
    let end = stat.size;
    for (let chunk = 0; chunk < limits.chunks && end > 0; chunk++) {
      const start = Math.max(0, end - 65536);
      const len = end - start;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(tp, 'r');
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);

      const lines = buf.toString('utf-8').split('\n');
      // A non-zero start can begin mid-line; that fragment is not valid JSON.
      const first = start === 0 ? 0 : 1;
      for (let i = lines.length - 1; i >= first; i--) {
        // Almost every line is assistant output or a tool result; skip those
        // before paying for JSON.parse.
        const line = lines[i];
        if (!mayCarryLabel(line)) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        const label = transcriptLabel(obj);
        if (!label) continue;
        if (label.kind === 'title') {
          if (titles.length < limits.titles && !titles.includes(label.text)) titles.push(label.text);
          continue;
        }
        if (label.kind === 'ai-title') {
          if (!aiTitle) aiTitle = label.text;
          continue;
        }
        if (userTexts.length < limits.labels && !userTexts.includes(label.text)) userTexts.push(label.text);
      }

      if (start === 0) break;
      end = start;
      // User messages are the bulk of a transcript; stop once the recent window
      // is full. A session's last title line can sit behind a large tool output,
      // so keep looking for a generated title for a few more chunks — but never
      // let an untitled session turn the shallow scan into a full-file read.
      if (userTexts.length >= limits.labels) {
        if (titles.length > 0 || aiTitle || ++chunksWithoutTitle >= 8) break;
      }
    }
  } catch { /* file vanished while reading */ }

  const labels = orderSessionLabels(titles, aiTitle, userTexts);
  sessionTitleCache.set(cacheKey, { labels, mtimeMs: stat.mtimeMs, size: stat.size });
  return labels;
}

function getSessionTitle(s: { cwd: string; sessionId: string }): string {
  return getSessionLabels(s)[0] || '';
}

/** Title + older labels, with the indexed first-message title as a fallback. */
function candidateTitles(
  s: { cwd: string; sessionId: string },
  fallback: string,
  deep = false,
): { title: string; altTitles: string[] } {
  const labels = getSessionLabels(s, deep);
  const title = labels[0] || fallback || '';
  const altTitles = labels.slice(1);
  if (fallback && fallback !== title) altTitles.push(fallback);
  return { title, altTitles };
}

// ─── Follow the conversation on screen ────────────────────────
// Before 1.3.0 the status bar followed the active Claude Code conversation
// tab. The rewrite dropped that and simply took the newest transcript, so a
// background session in another window hijacked the display. These helpers
// restore the old behaviour and add a workspace fallback.

/** Workspace roots of this window, used to prefer this window's own session. */
function workspaceRoots(): string[] {
  const roots: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    roots.push(folder.uri.fsPath);
  }
  if (roots.length === 0) {
    const wsFile = vscode.workspace.workspaceFile;
    if (wsFile && wsFile.scheme === 'file') roots.push(path.dirname(wsFile.fsPath));
  }
  return roots;
}

/** Every session we know about: the persistent index plus running processes. */
function collectFollowCandidates(liveSessions = scanSessions(), deep = false): FollowCandidate[] {
  const byId = new Map<string, FollowCandidate>();

  for (const entry of SessionStore.getAllSessions()) {
    const titles = candidateTitles({ cwd: entry.cwd, sessionId: entry.sessionId }, entry.title || '');
    byId.set(entry.sessionId, {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      // The index stores the first message; the tab shows a later one.
      title: titles.title,
      altTitles: titles.altTitles,
      // The index only refreshes the session being followed, so its timestamp
      // goes stale for every other tab. The transcript's own mtime is the
      // truth; `getSessionLabels` just stat'ed the file, so the cache holds it.
      lastUpdatedAt: sessionTitleCache.get(entry.sessionId)?.mtimeMs ?? entry.lastUpdatedAt,
      live: false,
    });
  }

  for (const s of liveSessions) {
    const tp = path.join(claudeDir(), 'projects', encodeProjectPath(s.cwd), s.sessionId + '.jsonl');
    let mtime = s.startedAt;
    try { mtime = fs.statSync(tp).mtimeMs; } catch { /* transcript gone */ }
    const indexed = byId.get(s.sessionId);
    const titles = candidateTitles(s, indexed?.title || '', deep);
    byId.set(s.sessionId, {
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: titles.title,
      altTitles: [...new Set([...titles.altTitles, ...(indexed?.altTitles || [])])].filter(t => t !== titles.title),
      lastUpdatedAt: mtime,
      live: true,
    });
  }

  return Array.from(byId.values());
}

/** The explicit or tab-bound session, dropped when its transcript disappeared. */
function resolveFollowOverride(): { sessionId: string; cwd: string } | null {
  const pick = manualSessionOverride || tabSessionOverride;
  if (!pick) return null;

  const tp = path.join(claudeDir(), 'projects', encodeProjectPath(pick.cwd), pick.sessionId + '.jsonl');
  if (fs.existsSync(tp)) return { sessionId: pick.sessionId, cwd: pick.cwd };

  if (manualSessionOverride && manualSessionOverride.sessionId === pick.sessionId) {
    manualSessionOverride = null;
  } else {
    tabSessionOverride = null;
  }
  return null;
}

/**
 * The active tab's label when it is a Claude Code conversation.
 * Returns null for files, diffs, notebooks, terminals and other extensions'
 * webviews — those must not change which session is displayed.
 */
function activeConversationLabel(): string | null {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (!tab) return null;
  const input = tab.input;
  if (
    input instanceof vscode.TabInputText
    || input instanceof vscode.TabInputTextDiff
    || input instanceof vscode.TabInputNotebook
    || input instanceof vscode.TabInputNotebookDiff
    || input instanceof vscode.TabInputTerminal
  ) {
    return null;
  }
  // Only Claude Code's own webview panel. Other webviews (markdown previews,
  // settings UIs) use arbitrary labels, which would otherwise trigger a
  // fruitless — and expensive — deep label scan on every switch.
  const viewType = (input as any)?.viewType;
  if (typeof viewType !== 'string' || !viewType.toLowerCase().includes('claude')) return null;
  return cleanTabLabel(tab.label);
}

/** React to tab switches; cheap enough to also call on a short interval. */
function onActiveTabChanged(): void {
  if (!currentConfig.followActiveTab) return;
  const label = activeConversationLabel();
  if (label === null) return;           // not a conversation tab — keep the current session
  if (label === lastTabLabel) return;   // same conversation, nothing to do
  lastTabLabel = label;

  // A command-palette pick only lasts until the user moves to another
  // conversation; after that the tab on screen decides again.
  if (manualSessionOverride && normalizeTitle(manualSessionOverride.label) !== normalizeTitle(label)) {
    manualSessionOverride = null;
  }

  applyTabLabel(label, 0);
}

/**
 * Append what each tab switch resolved to.
 *
 * "The status bar follows the wrong conversation" is invisible from the
 * outside: the only state that survives is the session that ended up on
 * screen, so a label that resolved to the wrong session looks exactly like one
 * that resolved correctly. This keeps the last few hundred resolutions in
 * `~/.claude/token-monitor/follow-log.jsonl` so the next report can be checked
 * against what actually happened instead of re-derived from scratch.
 */
function logFollow(label: string, match: TabMatch, attempt: number, usedDeep = false): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      attempt,
      deep: usedDeep,
      label,
      kind: match.kind,
      sessionId: match.kind === 'match' ? match.session.sessionId : null,
      live: match.kind === 'match' ? !!match.session.live : null,
    });
    fs.mkdirSync(tokenMonitorDir(), { recursive: true });
    const file = path.join(tokenMonitorDir(), 'follow-log.jsonl');
    fs.appendFileSync(file, line + '\n', 'utf-8');
    if (fs.statSync(file).size > 96 * 1024) {
      const kept = fs.readFileSync(file, 'utf-8').trim().split('\n').slice(-300);
      fs.writeFileSync(file, kept.join('\n') + '\n', 'utf-8');
    }
  } catch { /* diagnostics must never break following */ }
}

function applyTabLabel(label: string, attempt: number): void {
  if (followRetryTimer) { clearTimeout(followRetryTimer); followRetryTimer = null; }

  const roots = workspaceRoots();
  let match = pickSessionForTab(label, collectFollowCandidates(), roots);
  let usedDeep = false;

  // A tab keeps the name it was given, so its label can be older than the
  // recent window — and long tool outputs push it megabytes back. Only on a
  // miss, scan the running sessions' transcripts in full; that costs a few
  // hundred milliseconds and must not run on every tab switch.
  if (match.kind === 'none') {
    const live = scanSessions();
    if (live.length > 0) {
      const deepMatch = pickSessionForTab(label, collectFollowCandidates(live, true), roots);
      if (deepMatch.kind !== 'none') { match = deepMatch; usedDeep = true; }
    }
  }

  logFollow(label, match, attempt, usedDeep);

  if (match.kind === 'match') {
    tabIdle = false;
    tabSessionOverride = { sessionId: match.session.sessionId, cwd: match.session.cwd };
    poll();
    // Focusing a conversation tab starts its Claude Code process, so for about a
    // second the conversation on screen has no session file and can be missing
    // from the candidate list entirely. A binding that needed the deep scan, or
    // that landed on a session with no process, is therefore only a stand-in —
    // look again once the real session has registered rather than leaving the
    // status bar on the wrong conversation until the next switch.
    if (usedDeep || !match.session.live) scheduleFollowRetry(label, attempt, 2);
    return;
  }

  if (match.kind === 'empty') {
    tabIdle = true;
    tabSessionOverride = null;
    if (currentSessionId) resetState();
    updateStatusBar();
    // The first message may arrive while this tab is already on screen. Keep
    // checking for a moment so the display starts as soon as it does.
    scheduleFollowRetry(label, attempt, 4);
    return;
  }

  // A new conversation writes its ai-title only after the first message.
  // Retry a couple of times while the same tab stays active; until then keep
  // the current session rather than blanking the status bar.
  scheduleFollowRetry(label, attempt, 2);
}

function scheduleFollowRetry(label: string, attempt: number, maxAttempts: number): void {
  if (attempt >= maxAttempts) return;
  followRetryTimer = setTimeout(() => {
    followRetryTimer = null;
    if (lastTabLabel === label) applyTabLabel(label, attempt + 1);
  }, Math.min(8000, 1000 * Math.pow(2, attempt)));
}

// ─── Main poll ────────────────────────────────────────────────
function poll(): void {
  try {
    // 1. Find sessions with live transcripts
    const sessions = scanSessions();
    const override = resolveFollowOverride();

    if (sessions.length === 0 && !override && !tabIdle) {
      if (currentSessionId) resetState();
      updateStatusBar();
      return;
    }

    // 2. Pick the active session. An explicit pick wins, then the conversation
    //    tab on screen, then the freshest session in this window's workspace.
    let active: { sessionId: string; cwd: string } | null = override;

    if (!active && tabIdle) {
      if (currentSessionId) resetState();
      updateStatusBar();
      return;
    }

    if (!active) {
      if (sessions.length === 0) {
        updateStatusBar();
        return;
      }
      const liveCandidates: FollowCandidate[] = sessions.map(s => {
        const tp = path.join(claudeDir(), 'projects', encodeProjectPath(s.cwd), s.sessionId + '.jsonl');
        let lastUpdatedAt = s.startedAt;
        try { lastUpdatedAt = fs.statSync(tp).mtimeMs; } catch { /* transcript gone */ }
        return { sessionId: s.sessionId, cwd: s.cwd, title: '', lastUpdatedAt, live: true };
      });
      const newest = pickNewestSession(liveCandidates, workspaceRoots());
      if (!newest) {
        updateStatusBar();
        return;
      }
      active = { sessionId: newest.sessionId, cwd: newest.cwd };
    }
    const activeIsLive = sessions.some(s => s.sessionId === active!.sessionId);

    // 3. Build transcript path
    const encoded = encodeProjectPath(active.cwd);
    const tp = path.join(claudeDir(), 'projects', encoded, active.sessionId + '.jsonl');

    // 4. If session (or transcript path) changed, reset all state
    if (active.sessionId !== currentSessionId) {
      currentSessionId = active.sessionId;
      const indexed = SessionStore.loadIndex().sessions[active.sessionId];
      currentTitle = getSessionTitle(active) || indexed?.title || '';
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
      // Persist current session summary to the index. A historical session
      // opened from a tab must not look freshly active in the dashboard.
      if (activeIsLive) persistCurrentSession(active.cwd);
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
    let mtimeMs = -1, size = -1;
    try { const st = fs.statSync(lastTranscriptPath); mtimeMs = st.mtimeMs; size = st.size; } catch { /* */ }
    // Keep the labels already scanned: the tab may still be showing a previous
    // title, and an untitled tab falls back to user text.
    const previous = sessionTitleCache.get(currentSessionId);
    const labels = previous && previous.labels.includes(event.title)
      ? previous.labels
      : [event.title, ...(previous?.labels || [])];
    sessionTitleCache.set(currentSessionId, { labels, mtimeMs, size });
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
    parts.push(`${t('statusBar.turnAiTime')} ${formatThinkTime(turnAiAccumulatorMs)}`);
    parts.push(`${abbreviateTokens(turnTokens)} ${formatCost(costInDisplayCurrency(turnCost, currency), currency)}${unknownMark}`);
    parts.push(`${t('statusBar.cumulative')} ${abbreviateTokens(totalTokens)} ${formatCost(displayCumulativeCost, currency)}${unknownMark}`);
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
  // A rate is always in effect: remote → cache → built-in table. Only the
  // freshness differs, so never report the rate as "unknown".
  if (getRatesSource() === 'builtin') return t('rates.builtin');
  const ts = getRatesUpdatedAt();
  if (!ts || ts <= 1) return t('rates.builtin');
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
      label: zh ? '$(refresh) 跟随当前显示的会话' : '$(refresh) Follow the conversation on screen',
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
    manualSessionOverride = null;
    tabSessionOverride = null;
    tabIdle = false;
    currentSessionId = '';      // force the poller to switch sessions
    lastTabLabel = null;        // and let the tab on screen decide again
    onActiveTabChanged();
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
  // Remember which tab the pick was made from: moving to another conversation
  // hands control back to the tab.
  const title = SessionStore.loadIndex().sessions[picked.sessionId]?.title
    || getSessionTitle({ sessionId: picked.sessionId, cwd: picked.cwd });
  manualSessionOverride = {
    sessionId: picked.sessionId,
    cwd: picked.cwd,
    label: title || lastTabLabel || '',
  };
  tabIdle = false;
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

  // Tab following toggled → drop any tab binding and let the poller decide
  if (!currentConfig.followActiveTab) {
    tabSessionOverride = null;
    tabIdle = false;
    lastTabLabel = null;
  } else {
    onActiveTabChanged();
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

  // Follow the conversation tab that is on screen. Re-focusing a tab that is
  // already active in another group does not fire onDidChangeTabs, so the
  // label is checked on a short interval too (string comparison only, no I/O).
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => onActiveTabChanged()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => onActiveTabChanged())
  );
  const tabFocusTimer = setInterval(onActiveTabChanged, 500);
  context.subscriptions.push({ dispose: () => clearInterval(tabFocusTimer) });

  // Initial poll
  poll();
  onActiveTabChanged();
  pollTimer = setInterval(poll, currentConfig.pollIntervalMs);

  console.log('[TokenMonitor] Activated.');
}

export function deactivate(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (standaloneSyncTimer) { clearInterval(standaloneSyncTimer); standaloneSyncTimer = null; }
  if (pricingRefreshTimer) { clearInterval(pricingRefreshTimer); pricingRefreshTimer = null; }
  if (indexRefreshTimer) { clearTimeout(indexRefreshTimer); indexRefreshTimer = null; }
  if (followRetryTimer) { clearTimeout(followRetryTimer); followRetryTimer = null; }
  console.log('[TokenMonitor] Deactivated.');
}
