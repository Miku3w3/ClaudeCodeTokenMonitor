// DetailPanel — VSCode WebviewView provider for the token usage panel.
// v0.12.0: Filter bar with time range + session selection + by-model grouping.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { PerMessageStats, AggregatedData, SessionIndexEntry, ModelStatEntry } from '../model/types';
import type { AgentStats } from '../core/agentView';

export interface PanelData {
  sessionId: string;
  title: string;
  model: string;
  isActive: boolean;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCacheReadTokens: number;
  cumulativeCostCNY: number;
  totalTokens: number;
  messageCount: number;
  messages: PerMessageStats[];
  lastUpdatedAt: string;
  /** Accumulated AI working time in current turn (ms) */
  turnAiTimeMs?: number;
  lang?: string;
  currency?: string;
  pollIntervalMs?: number;
  /** Per-model breakdown (always present from v0.12.0) */
  modelStats?: ModelStatEntry[];
  /** Main vs subagent split computed from the FULL message list (v1.3.0) */
  agentStats?: AgentStats;
}

export type I18nProvider = () => {
  t: (key: string, params?: Record<string, string>) => string;
  lang: string;
  currency: string;
  isRTL: boolean;
};

export type FilterMessageHandler = (msg: { type: string; timeRange?: string; sessionId?: string }) => void;

export class DetailPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private pendingData: PanelData | null = null;
  private getI18n: I18nProvider;
  private onFilterMessage: FilterMessageHandler | null = null;

  constructor(getI18n: I18nProvider) {
    this.getI18n = getI18n;
  }

  /** Register a callback for filter-related messages from the webview. */
  setFilterMessageHandler(handler: FilterMessageHandler): void {
    this.onFilterMessage = handler;
  }

  /** Called by extension when language changes to rebuild the webview. */
  refreshHtml(): void {
    if (this.view) {
      this.view.webview.html = this.getHtml();
      if (this.pendingData) {
        this.sendToWebview(this.pendingData);
      }
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'ready' && this.pendingData) {
        this.sendToWebview(this.pendingData);
      } else if (msg.type === 'openSettings') {
        vscode.commands.executeCommand('claudeCodeTokenMonitor.openSettings');
      } else if (msg.type === 'setTimeRange' || msg.type === 'selectSession' || msg.type === 'clearSessionSelection') {
        if (this.onFilterMessage) this.onFilterMessage(msg);
      }
    });

    if (this.pendingData) {
      this.sendToWebview(this.pendingData);
    }
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
    }
  }

  pushData(data: PanelData): void {
    this.pendingData = data;
    if (this.view) {
      this.sendToWebview(data);
    }
  }

  /** Return all translatable strings as a JSON object for the webview. */
  getTranslations(): Record<string, string> {
    const { t } = this.getI18n();
    return {
      noSession: t('panel.noSession'),
      noSessionHint: t('panel.noSessionHint'),
      totalTokens: t('panel.totalTokens'),
      totalCost: t('panel.totalCost'),
      inputTokens: t('panel.inputTokens'),
      cacheHits: t('panel.cacheHits'),
      outputTokens: t('panel.outputTokens'),
      messagesCount: t('panel.messagesCount'),
      autoRefresh: t('panel.autoRefresh'),
      type: t('panel.type'),
      user: t('panel.user'),
      ai: t('panel.ai'),
      mainAgent: t('panel.mainAgent'),
      subagent: t('panel.subagent'),
      agentSplit: t('panel.agentSplit'),
      agentBreakdown: t('panel.agentBreakdown'),
      filterAllAgents: t('panel.filter.allAgents'),
      filterMainOnly: t('panel.filter.mainOnly'),
      filterSubOnly: t('panel.filter.subOnly'),
      input: t('panel.input'),
      cache: t('panel.cache'),
      output: t('panel.output'),
      cost: t('panel.cost'),
      thinking: t('panel.thinking'),
      settings: t('panel.settings'),
      pauseRefresh: t('panel.pauseRefresh'),
      resumeRefresh: t('panel.resumeRefresh'),
      lastModel: t('tooltip.lastModel'),
      modelLabel: t('tooltip.model'),
      totalInput: t('tooltip.totalInput'),
      cacheMiss: t('tooltip.cacheMiss'),
      hitRate: t('tooltip.hitRate'),
      filterCurrent: t('panel.filter.currentSession'),
      filterDaily: t('panel.filter.daily'),
      filterWeekly: t('panel.filter.weekly'),
      filterMonthly: t('panel.filter.monthly'),
      filterYearly: t('panel.filter.yearly'),
      filterAll: t('panel.filter.all'),
      filterSelectSession: t('panel.filter.selectSession'),
      filterByModel: t('panel.filter.byModel'),
      filterAllSessions: t('panel.filter.allSessions'),
      aggSessionsCount: t('panel.aggregate.sessionsCount'),
      aggNoSessions: t('panel.aggregate.noSessions'),
      turnAiTime: t('panel.turnAiTime'),
    };
  }

  /** Send aggregated data for time-range views (daily/weekly/yearly/all). */
  pushAggregatedData(data: AggregatedData): void {
    const i18n = this.getI18n();
    this.view?.webview.postMessage({
      type: 'aggregatedData',
      data,
      lang: i18n.lang,
      currency: i18n.currency,
      i18n: this.getTranslations(),
    });
  }

  /** Send the list of known sessions for the dropdown. */
  pushSessionList(sessions: Array<{ sessionId: string; title: string; startedAt: number }>): void {
    this.view?.webview.postMessage({
      type: 'sessionList',
      sessions,
    });
  }

  /** Send full detail for a selected (possibly past) session. */
  pushSessionDetail(session: PanelData): void {
    this.view?.webview.postMessage({
      type: 'sessionDetail',
      session,
      lang: session.lang || 'en',
      currency: session.currency || 'USD',
      i18n: this.getTranslations(),
    });
  }

  private sendToWebview(data: PanelData): void {
    this.view?.webview.postMessage({
      type: 'fullUpdate',
      session: data,
      lang: data.lang || 'en',
      currency: data.currency || 'USD',
      sessionList: (data as any).sessionList || [],
      i18n: this.getTranslations(),
    });
  }

  // ─── HTML (generated with current i18n) ─────────────────────

  getHtml(): string {
    const { t, lang, currency, isRTL } = this.getI18n();
    // Build a JS dictionary of all translated strings needed by the frontend
    const STR: Record<string, string> = {
      noSession: t('panel.noSession'),
      noSessionHint: t('panel.noSessionHint'),
      totalTokens: t('panel.totalTokens'),
      totalCost: t('panel.totalCost'),
      inputTokens: t('panel.inputTokens'),
      cacheHits: t('panel.cacheHits'),
      outputTokens: t('panel.outputTokens'),
      messagesCount: t('panel.messagesCount'),
      autoRefresh: t('panel.autoRefresh'),
      type: t('panel.type'),
      user: t('panel.user'),
      ai: t('panel.ai'),
      mainAgent: t('panel.mainAgent'),
      subagent: t('panel.subagent'),
      agentSplit: t('panel.agentSplit'),
      agentBreakdown: t('panel.agentBreakdown'),
      filterAllAgents: t('panel.filter.allAgents'),
      filterMainOnly: t('panel.filter.mainOnly'),
      filterSubOnly: t('panel.filter.subOnly'),
      input: t('panel.input'),
      cache: t('panel.cache'),
      output: t('panel.output'),
      cost: t('panel.cost'),
      thinking: t('panel.thinking'),
      settings: t('panel.settings'),
      pauseRefresh: t('panel.pauseRefresh'),
      resumeRefresh: t('panel.resumeRefresh'),
      lastModel: t('tooltip.lastModel'),
      modelLabel: t('tooltip.model'),
      totalInput: t('tooltip.totalInput'),
      cacheMiss: t('tooltip.cacheMiss'),
      hitRate: t('tooltip.hitRate'),
      // v0.12.0 filter keys
      filterCurrent: t('panel.filter.currentSession'),
      filterDaily: t('panel.filter.daily'),
      filterWeekly: t('panel.filter.weekly'),
      filterMonthly: t('panel.filter.monthly'),
      filterYearly: t('panel.filter.yearly'),
      filterAll: t('panel.filter.all'),
      filterSelectSession: t('panel.filter.selectSession'),
      filterByModel: t('panel.filter.byModel'),
      filterAllSessions: t('panel.filter.allSessions'),
      aggSessionsCount: t('panel.aggregate.sessionsCount'),
      aggNoSessions: t('panel.aggregate.noSessions'),
      turnAiTime: t('panel.turnAiTime'),
    };
    const strJson = JSON.stringify(STR);
    const dirAttr = isRTL ? ' dir="rtl"' : '';
    const nonce = crypto.randomBytes(16).toString('base64');

    return `<!DOCTYPE html>
<html lang="${lang}"${dirAttr}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${t('panel.title')}</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --border: var(--vscode-panel-border, #3c3c3c);
    --card-bg: var(--vscode-editor-inactiveSelectionBackground, #3a3d41);
    --accent: var(--vscode-charts-green, #89d185);
    --accent2: var(--vscode-charts-blue, #40a6ff);
    /* subagents: purple, independent of the theme's blue/green chart palette */
    --sub: var(--vscode-charts-purple, #c586c0);
    --warn: var(--vscode-charts-yellow, #e2b714);
    --muted: var(--vscode-descriptionForeground, #9d9d9d);
    --font: var(--vscode-font-family, 'Consolas', monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: var(--font); font-size: 12px;
    padding: 12px; line-height: 1.5;
  }
  .header { margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .header h2 { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .header .meta { color: var(--muted); font-size: 11px; }
  .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
  .stat-card { background: var(--card-bg); border-radius: 6px; padding: 10px 12px; text-align: center; }
  .stat-card .label { font-size: 10px; color: var(--muted); letter-spacing: 0.5px; margin-bottom: 4px; }
  .stat-card .value { font-size: 16px; font-weight: 700; color: var(--accent); }
  .stat-card .value.cost { color: var(--accent2); }
  .table-container { max-height: 400px; overflow-y: auto; overflow-x: auto; border: 1px solid var(--border); border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; }
  thead { position: sticky; top: 0; background: var(--bg); z-index: 1; }
  th { font-size: 10px; font-weight: 600; color: var(--muted); padding: 6px 8px; text-align: right; border-bottom: 2px solid var(--border); }
  th:first-child { text-align: center; width: 30px; } th:nth-child(2) { text-align: left; width: 40px; }
  td { padding: 4px 8px; text-align: right; border-bottom: 1px solid var(--border); font-size: 11px; font-variant-numeric: tabular-nums; }
  td:first-child { text-align: center; color: var(--muted); } td:nth-child(2) { text-align: left; }
  .row-user td { color: var(--muted); }
  .row-assistant td:last-child { color: var(--accent2); }
  .think-time { font-size: 10px; color: var(--warn); }
  .footer { margin-top: 8px; font-size: 10px; color: var(--muted); text-align: center; }
  .idle { text-align: center; padding: 40px; color: var(--muted); font-size: 14px; }
  .settings-btn { position: fixed; top: 14px; right: 24px; background: var(--card-bg); border: 1px solid var(--border); color: var(--fg); padding: 4px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: var(--font); z-index: 10; }
  .settings-btn:hover { background: var(--accent2); color: #fff; }
  .pause-btn { margin-left: 8px; background: var(--card-bg); border: 1px solid var(--border); color: var(--fg); padding: 1px 8px; border-radius: 3px; cursor: pointer; font-size: 10px; font-family: var(--font); vertical-align: middle; }
  .pause-btn:hover { background: var(--accent2); color: #fff; }
  .model-btn { background: var(--card-bg); border: 1px solid var(--border); color: var(--fg); padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-family: var(--font); width: 100%; text-align: left; }
  .model-btn:hover { background: var(--accent2); color: #fff; }
  .model-detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 6px; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
  .model-detail-grid .stat-card .value { font-size: 12px; }
  /* v0.12.0 filter bar */
  .filter-bar { margin-bottom: 10px; }
  .filter-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
  .filter-tab { background: var(--card-bg); border: 1px solid var(--border); color: var(--fg); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-family: var(--font); line-height: 16px; }
  .filter-tab:hover { border-color: var(--accent2); }
  .filter-tab.active { background: var(--accent2); color: #fff; border-color: var(--accent2); }
  .filter-secondary { display: flex; gap: 8px; align-items: center; font-size: 11px; }
  .filter-select { background: var(--card-bg); border: 1px solid var(--border); color: var(--fg); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-family: var(--font); cursor: pointer; }
  .filter-select option { background: var(--bg); color: var(--fg); padding: 4px 8px; }
  .filter-select:focus { outline: 1px solid var(--accent2); }
  .filter-toggle { display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--muted); user-select: none; }
  .filter-toggle.checked { color: var(--accent2); }
  .filter-toggle input { margin: 0; cursor: pointer; }
  .session-summary-row { cursor: pointer; }
  .session-summary-row:hover td { background: var(--card-bg); }
  /* v1.3.0 main/subagent split */
  .agent-chip { display: inline-block; margin-left: 4px; padding: 0 4px; border-radius: 3px; background: var(--bg); border: 1px solid var(--border); color: var(--sub); font-size: 9px; font-family: ui-monospace, monospace; vertical-align: middle; }
  .agent-split { margin-bottom: 10px; padding: 8px 10px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; }
  .agent-split-head { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); margin-bottom: 5px; }
  .agent-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--border); }
  .agent-bar-main { background: var(--accent); height: 100%; }
  .agent-bar-sub { background: var(--sub); height: 100%; }
  .agent-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 5px; font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .agent-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
  .row-subagent td:first-child { color: var(--sub); font-weight: 600; }
  .agent-breakdown { margin-top: 4px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .agent-breakdown table { width: 100%; border-collapse: collapse; }
  .agent-breakdown th, .agent-breakdown td { padding: 3px 6px; font-size: 10px; }
  .agent-breakdown th:first-child, .agent-breakdown td:first-child { text-align: left; }
  .empty-row td { text-align: center !important; color: var(--muted); padding: 16px !important; }
  /* Narrow side panels */
  @media (max-width: 380px) {
    th, td { padding: 3px 4px; }
    .cell-time { display: none; }
    .agent-legend { gap: 2px 8px; }
    .agent-split { padding: 6px 8px; }
  }
</style>
</head>
<body>
<button class="settings-btn" data-action="settings" title="Open extension settings">&#9881; ${t('panel.settings')}</button>
<div id="filter-bar"></div>
<div id="app">
  <div class="idle">
    <div>${t('panel.noSession')}</div>
    <div style="font-size:11px;margin-top:4px">${t('panel.noSessionHint')}</div>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let sessionData = null;

// i18n strings — updated dynamically from messages when language changes
let STR = ${strJson};

const CURRENCY_SYMBOLS = { CNY: '\\u00A5', USD: '$', EUR: '\\u20AC', JPY: '\\u00A5', KRW: '\\u20A9', GBP: '\\u00A3' };

vscode.postMessage({ type: 'ready' });

let currentLang = '${lang}';
let currentCurrency = '${currency}';
let currentPollMs = 2000;
let isPaused = false;
// v0.12.0 filter state
let currentTimeRange = 'current';
let isGroupByModel = false;
let currentAgentFilter = 'all';
let selectedSessionId = null;
let aggregatedData = null;
let sessionList = [];

// Initialize filter bar (must be after var declarations — uses currentTimeRange, etc.)
try { renderFilterBar(); } catch(e) { console.error('renderFilterBar error:', e); }

function toggleModelDetail(idx) {
  var el = document.getElementById('modelDetail-' + idx);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function toggleAgentBreakdown() {
  var el = document.getElementById('agentBreakdown');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function togglePause() {
  isPaused = !isPaused;
  if (!isPaused && sessionData) {
    renderFull(sessionData);
  }
  var btn = document.getElementById('pauseBtn');
  if (btn) btn.textContent = isPaused ? STR.resumeRefresh : STR.pauseRefresh;
}

function renderFilterBar() {
  var tabs = [
    { id: 'current', label: STR.filterCurrent },
    { id: 'daily', label: STR.filterDaily },
    { id: 'weekly', label: STR.filterWeekly },
    { id: 'monthly', label: STR.filterMonthly },
    { id: 'yearly', label: STR.filterYearly },
    { id: 'all', label: STR.filterAll },
  ];
  var tabsHtml = tabs.map(function(t) {
    var cls = 'filter-tab' + (t.id === currentTimeRange ? ' active' : '');
    return '<button class="' + cls + '" data-tr="' + t.id + '">' + t.label + '</button>';
  }).join('');
  var byModelChecked = isGroupByModel ? ' checked' : '';
  var byModelCls = 'filter-toggle' + (isGroupByModel ? ' checked' : '');
  // One-row layout: tabs + select + checkbox all inline
  var btnStyle = 'padding:2px 8px;font-size:11px;font-family:var(--font);border-radius:4px;cursor:pointer;background:var(--card-bg);border:1px solid var(--border);color:var(--fg);box-sizing:border-box';
  var html = '<div class="filter-bar" style="display:flex;align-items:stretch;gap:6px;flex-wrap:wrap">' +
    '<div class="filter-tabs" id="filterTabs" style="display:flex;gap:4px">' + tabsHtml + '</div>' +
    '<select id="sessionSelect" class="filter-select" style="min-width:100px;' + btnStyle + '"><option value="">' + STR.filterAllSessions + '</option></select>' +
    '<select id="agentSelect" class="filter-select" style="min-width:92px;' + btnStyle + '">' +
      '<option value="all">' + STR.filterAllAgents + '</option>' +
      '<option value="main">' + STR.filterMainOnly + '</option>' +
      '<option value="sub">' + STR.filterSubOnly + '</option>' +
    '</select>' +
    '<label id="byModelLabel" class="' + byModelCls + '" style="display:flex;align-items:center;gap:3px;white-space:nowrap;' + btnStyle + '">' +
      '<input type="checkbox" id="byModelCheck" ' + byModelChecked + ' style="margin:0"> ' + STR.filterByModel +
    '</label>' +
  '</div>';
  document.getElementById('filter-bar').innerHTML = html;
  if (sessionList.length > 0) updateSessionDropdown();

  // Event delegation for filter tabs
  var tabsEl = document.getElementById('filterTabs');
  if (tabsEl) {
    tabsEl.onclick = function(e) {
      var btn = e.target.closest ? e.target.closest('.filter-tab') : null;
      if (!btn) return;
      var tr = btn.getAttribute('data-tr');
      if (tr) setTimeRange(tr);
    };
  }

  // Session select onchange
  var sel = document.getElementById('sessionSelect');
  if (sel) {
    sel.onchange = function() {
      if (sel.value) selectSession(sel.value);
      else {
        selectedSessionId = null;
        currentTimeRange = 'current';
        updateFilterUI();
        if (sessionData) renderFull(sessionData);
      }
    };
  }

  // By-model checkbox onchange
  var cb = document.getElementById('byModelCheck');
  if (cb) cb.onchange = toggleGroupByModel;

  // Agent filter (all / main / sub)
  var agentSel = document.getElementById('agentSelect');
  if (agentSel) {
    agentSel.value = currentAgentFilter;
    agentSel.onchange = function() {
      currentAgentFilter = agentSel.value || 'all';
      if (sessionData) renderFull(sessionData);
    };
  }
}

function updateFilterUI() {
  // Update tab active states
  var tabs = document.querySelectorAll('.filter-tab');
  for (var i = 0; i < tabs.length; i++) {
    var tr = tabs[i].getAttribute('data-tr');
    if (tr === currentTimeRange) tabs[i].classList.add('active');
    else tabs[i].classList.remove('active');
  }
  // Update checkbox
  var cb = document.getElementById('byModelCheck');
  var lbl = document.getElementById('byModelLabel');
  if (cb) cb.checked = isGroupByModel;
  if (lbl) lbl.className = 'filter-toggle' + (isGroupByModel ? ' checked' : '');
  // Update dropdown selection
  var sel = document.getElementById('sessionSelect');
  if (sel && selectedSessionId) sel.value = selectedSessionId;
  else if (sel && !selectedSessionId && currentTimeRange === 'current') sel.value = '';
  // Keep the agent filter in sync after re-renders
  var agentSel = document.getElementById('agentSelect');
  if (agentSel) agentSel.value = currentAgentFilter;
}

function setTimeRange(tr) {
  currentTimeRange = tr;
  selectedSessionId = null;
  updateFilterUI();
  if (tr === 'current') {
    if (sessionData) renderFull(sessionData);
  }
  vscode.postMessage({ type: 'setTimeRange', timeRange: tr });
}
function selectSession(sid) {
  selectedSessionId = sid;
  currentTimeRange = '';
  updateFilterUI();
  vscode.postMessage({ type: 'selectSession', sessionId: sid });
}
function toggleGroupByModel() {
  isGroupByModel = !isGroupByModel;
  updateFilterUI();
  if (aggregatedData) renderAggregated(aggregatedData);
  else if (sessionData) renderFull(sessionData);
}

function openSettings() {
  vscode.postMessage({ type: 'openSettings' });
}

// CSP-safe delegated click handling (inline onclick attributes are blocked by the webview CSP)
document.addEventListener('click', function(e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  var action = el.getAttribute('data-action');
  if (action === 'settings') {
    openSettings();
  } else if (action === 'toggle-model') {
    toggleModelDetail(Number(el.getAttribute('data-model-index')));
  } else if (action === 'toggle-agent') {
    toggleAgentBreakdown();
  } else if (action === 'toggle-pause') {
    togglePause();
  }
});

// Apply updated i18n strings dynamically without page reload
function applyI18n(i18n) {
  if (!i18n) return;
  var changed = false;
  for (var k in i18n) {
    if (i18n.hasOwnProperty(k) && STR[k] !== i18n[k]) {
      STR[k] = i18n[k];
      changed = true;
    }
  }
  if (changed) renderFilterBar();
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'log') { console.log('[webview]', msg.text); return; }
  if (msg.type === 'fullUpdate' && msg.session) {
    console.log('[webview] fullUpdate received, msgs:', msg.session.messages ? msg.session.messages.length : 0);
    applyI18n(msg.i18n);
    if (msg.lang) currentLang = msg.lang;
    if (msg.currency) currentCurrency = msg.currency;
    if (msg.session.pollIntervalMs) currentPollMs = msg.session.pollIntervalMs;
    if (msg.sessionList) { sessionList = msg.sessionList; updateSessionDropdown(); }
    // Only update sessionData and render if in 'current' view (not viewing a historical session)
    if (!isPaused && currentTimeRange === 'current' && !selectedSessionId) {
      sessionData = msg.session;
      aggregatedData = null;
      renderFull(sessionData);
    }
  } else if (msg.type === 'aggregatedData' && msg.data) {
    applyI18n(msg.i18n);
    aggregatedData = msg.data;
    if (msg.lang) currentLang = msg.lang;
    if (msg.currency) currentCurrency = msg.currency;
    if (!isPaused) renderAggregated(msg.data);
  } else if (msg.type === 'sessionList') {
    sessionList = msg.sessions || [];
    updateSessionDropdown();
  } else if (msg.type === 'sessionDetail' && msg.session) {
    applyI18n(msg.i18n);
    // Viewing a historical session — save to sessionData and render as snapshot
    if (!isPaused) {
      sessionData = msg.session;
      aggregatedData = null;
      currentTimeRange = '';
      renderFull(msg.session);
    }
  }
});

function fmtCost(c) {
  if (!isFinite(c)) return '—';
  var sym = CURRENCY_SYMBOLS[currentCurrency] || currentCurrency;
  if (c >= 100) return sym + c.toFixed(2);
  if (c >= 1) return sym + c.toFixed(3);
  if (c >= 0.01) return sym + c.toFixed(4);
  return sym + c.toFixed(5);
}
function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) { var k = n / 1000; return (k >= 100 ? Math.round(k) : k.toFixed(1)) + 'K'; }
  var m = n / 1000000; return (m >= 100 ? Math.round(m) : m.toFixed(1)) + 'M';
}
function fmtThink(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms/60000) + 'm ' + Math.round((ms%60000)/1000) + 's';
}
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtTime(ts) {
  try {
    var loc = currentLang === 'zh-CN' ? 'zh-CN' : currentLang === 'ja' ? 'ja-JP' : currentLang === 'ko' ? 'ko-KR' : 'en-US';
    return new Date(ts).toLocaleTimeString(loc, {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  } catch(e) { return new Date(ts).toLocaleTimeString(); }
}

function updateSessionDropdown() {
  var sel = document.getElementById('sessionSelect');
  if (!sel) return;
  // Preserve current selection before rebuilding
  var prevVal = selectedSessionId || (sel.value || '');
  sel.innerHTML = '<option value="">' + STR.filterAllSessions + '</option>';
  for (var i = 0; i < sessionList.length; i++) {
    var s = sessionList[i];
    var d = new Date(s.startedAt);
    var dateStr = d.toLocaleDateString(currentLang === 'zh-CN' ? 'zh-CN' : 'en-US', {month:'short',day:'numeric'});
    var label = s.title + ' (' + dateStr + ')';
    sel.innerHTML += '<option value="' + esc(s.sessionId) + '">' + esc(label) + '</option>';
  }
  // Restore selection if still valid
  if (prevVal) {
    for (var j = 0; j < sel.options.length; j++) {
      if (sel.options[j].value === prevVal) { sel.value = prevVal; break; }
    }
  }
}

function renderFull(s) {
  // Save expanded model details state
  var expandedModels = [];
  for (var i = 0; i < 100; i++) {
    var el = document.getElementById('modelDetail-' + i);
    if (el && el.style.display !== 'none') expandedModels.push(i);
  }

  var cumInput = s.cumulativeInputTokens + s.cumulativeCacheReadTokens;
  var cumHitRate = cumInput > 0 ? (s.cumulativeCacheReadTokens / cumInput * 100).toFixed(1) + '%' : '0%';

  // v1.3.0: split main vs subagent usage.
  // Prefer the authoritative stats computed from the full message list — the
  // table only carries a recent window, which must never drive the split.
  var allMsgs = s.messages || [];
  var splitMain = { tokens: 0, cost: 0, msgs: 0 };
  var splitSub = { tokens: 0, cost: 0, msgs: 0 };
  var agentList = [];
  var hasSub = false;

  if (s.agentStats) {
    splitMain = {
      tokens: s.agentStats.main.tokens || 0,
      cost: s.agentStats.main.cost || 0,
      msgs: s.agentStats.main.messages || 0,
    };
    splitSub = {
      tokens: s.agentStats.sub.tokens || 0,
      cost: s.agentStats.sub.cost || 0,
      msgs: s.agentStats.sub.messages || 0,
    };
    agentList = (s.agentStats.agents || []).map(function(a) {
      return { id: a.id, label: a.label, tokens: a.tokens, cost: a.cost, msgs: a.messages };
    });
    hasSub = splitSub.msgs > 0;
  } else {
    // Fallback for callers that do not send agentStats (older payloads/tests)
    var agentMap = {};
    for (var mi = 0; mi < allMsgs.length; mi++) {
      var mm = allMsgs[mi];
      if (mm.isUserMessage) continue;
      var mmCost = (mm.costDisplay != null ? mm.costDisplay : mm.costCNY) || 0;
      var mmTok = (mm.inputTokens || 0) + (mm.cacheReadTokens || 0) + (mm.outputTokens || 0);
      var bucket = mm.source === 'subagent' ? splitSub : splitMain;
      bucket.tokens += mmTok; bucket.cost += mmCost; bucket.msgs++;
      if (mm.source === 'subagent') {
        hasSub = true;
        var aid = mm.agentId || 'unknown';
        if (!agentMap[aid]) agentMap[aid] = { id: aid, label: mm.agentLabel || aid.slice(0, 8), tokens: 0, cost: 0, msgs: 0 };
        agentMap[aid].tokens += mmTok; agentMap[aid].cost += mmCost; agentMap[aid].msgs++;
      }
    }
    agentList = Object.keys(agentMap).map(function(k) { return agentMap[k]; })
      .sort(function(a, b) { return b.cost - a.cost; });
  }
  var splitCostTotal = splitMain.cost + splitSub.cost;
  var subCostPct = splitCostTotal > 0 ? splitSub.cost / splitCostTotal * 100 : 0;
  var mainCostPct = 100 - subCostPct;

  // Main/subagent split strip (only when subagent activity exists)
  var agentSplitHtml = '';
  if (hasSub) {
    agentSplitHtml = '<div class="agent-split">' +
      '<div class="agent-split-head"><span>&#129513; ' + STR.agentSplit + '</span><span>' + STR.subagent + ' ' + subCostPct.toFixed(1) + '%</span></div>' +
      '<div class="agent-bar">' +
        '<div class="agent-bar-main" style="width:' + mainCostPct.toFixed(1) + '%"></div>' +
        (subCostPct > 0 ? '<div class="agent-bar-sub" style="width:' + subCostPct.toFixed(1) + '%"></div>' : '') +
      '</div>' +
      '<div class="agent-legend">' +
        '<span><span class="agent-dot" style="background:var(--accent)"></span>' + STR.mainAgent + ' ' + fmtCost(splitMain.cost) + ' &middot; ' + mainCostPct.toFixed(1) + '%</span>' +
        '<span><span class="agent-dot" style="background:var(--sub)"></span>' + STR.subagent + ' ' + fmtCost(splitSub.cost) + ' &middot; ' + subCostPct.toFixed(1) + '%</span>' +
      '</div>' +
    '</div>';
  }

  // Collapsible per-agent breakdown
  var agentBreakdownHtml = '';
  if (hasSub) {
    var abEl0 = document.getElementById('agentBreakdown');
    var abOpen = !!(abEl0 && abEl0.style.display !== 'none');
    agentBreakdownHtml = '<div style="margin-bottom:10px">' +
      '<button class="model-btn" data-action="toggle-agent">&#128193; ' + STR.agentBreakdown + ' (' + agentList.length + ')</button>' +
      '<div id="agentBreakdown" style="' + (abOpen ? 'display:block' : 'display:none') + ';margin-top:4px">' +
        '<div class="agent-breakdown"><table><thead><tr><th>' + STR.subagent + '</th><th style="text-align:right">' + STR.messagesCount + '</th><th style="text-align:right">' + STR.totalTokens + '</th><th style="text-align:right">' + STR.cost + '</th></tr></thead><tbody>' +
          agentList.map(function(a) {
            return '<tr><td><span class="agent-chip" style="margin-left:0">' + esc(a.label) + '</span></td>' +
              '<td style="text-align:right">' + a.msgs + '</td>' +
              '<td style="text-align:right">' + fmtTokens(a.tokens) + '</td>' +
              '<td style="text-align:right">' + fmtCost(a.cost) + '</td></tr>';
          }).join('') +
        '</tbody></table></div>' +
      '</div>' +
    '</div>';
  }

  // Model stats (collapsible, only when multiple models used AND not in by-model mode)
  var modelStatsHtml = '';
  if (!isGroupByModel && s.modelStats && s.modelStats.length > 1) {
    modelStatsHtml = '<div style="margin-top:8px">' +
      s.modelStats.map(function(ms, idx) {
        var hitRate = ms.inputTokens > 0 ? (ms.cacheHits / ms.inputTokens * 100).toFixed(1) + '%' : '0%';
        return '<div style="margin-bottom:4px">' +
          '<button class="model-btn" data-action="toggle-model" data-model-index="' + idx + '">' +
            '&#128202; ' + esc(ms.model) + ' &nbsp; ' + fmtCost(ms.cost) + ' (' + fmtTokens(ms.tokens) + ')' +
          '</button>' +
          '<div id="modelDetail-' + idx + '" style="display:none;margin:4px 0 8px 0">' +
            '<div class="model-detail-grid">' +
              '<div class="stat-card"><div class="label">&#128230; ' + STR.totalTokens + '</div><div class="value">' + fmtTokens(ms.tokens) + '</div></div>' +
              '<div class="stat-card"><div class="label">&#128176; ' + STR.totalCost + '</div><div class="value cost">' + fmtCost(ms.cost) + '</div></div>' +
              '<div class="stat-card"><div class="label">&#128229; ' + STR.totalInput + '</div><div class="value">' + fmtTokens(ms.inputTokens) + '</div></div>' +
              '<div class="stat-card"><div class="label">&#9989; ' + STR.cacheHits + '</div><div class="value">' + fmtTokens(ms.cacheHits) + '</div></div>' +
              '<div class="stat-card"><div class="label">&#10060; ' + STR.cacheMiss + '</div><div class="value">' + fmtTokens(ms.cacheMiss) + '</div></div>' +
              '<div class="stat-card"><div class="label">&#128200; ' + STR.hitRate + '</div><div class="value">' + hitRate + '</div></div>' +
              '<div class="stat-card"><div class="label">&#128228; ' + STR.output + '</div><div class="value">' + fmtTokens(ms.outputTokens) + '</div></div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
  }

  // Build stats cards — either aggregate or per-model
  var statsHtml = '';
  if (isGroupByModel && s.modelStats && s.modelStats.length > 0) {
    // Per-model cards
    statsHtml = s.modelStats.map(function(ms) {
      var hitRate = ms.inputTokens > 0 ? (ms.cacheHits / ms.inputTokens * 100).toFixed(1) + '%' : '0%';
      return '<div style="margin-bottom:6px">' +
        '<div style="font-weight:600;margin-bottom:4px;color:var(--accent2);font-size:11px">' + esc(ms.model) + ' - ' + fmtCost(ms.cost) + '</div>' +
        '<div class="model-detail-grid">' +
          '<div class="stat-card"><div class="label">&#128230; ' + STR.totalTokens + '</div><div class="value">' + fmtTokens(ms.tokens) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#128176; ' + STR.totalCost + '</div><div class="value cost">' + fmtCost(ms.cost) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#128229; ' + STR.totalInput + '</div><div class="value">' + fmtTokens(ms.inputTokens) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#9989; ' + STR.cacheHits + '</div><div class="value">' + fmtTokens(ms.cacheHits) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#10060; ' + STR.cacheMiss + '</div><div class="value">' + fmtTokens(ms.cacheMiss) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#128200; ' + STR.hitRate + '</div><div class="value">' + hitRate + '</div></div>' +
          '<div class="stat-card"><div class="label">&#128228; ' + STR.output + '</div><div class="value">' + fmtTokens(ms.outputTokens) + '</div></div>' +
        '</div>' +
      '</div>';
    }).join('');
  } else {
    // Default aggregate cards
    statsHtml = '<div class="stats-grid">' +
      '<div class="stat-card"><div class="label">&#128230; ' + STR.totalTokens + '</div><div class="value">' + fmtTokens(s.totalTokens) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#128176; ' + STR.totalCost + '</div><div class="value cost">' + fmtCost(s.cumulativeCostCNY) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#128229; ' + STR.totalInput + '</div><div class="value">' + fmtTokens(cumInput) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#9989; ' + STR.cacheHits + '</div><div class="value">' + fmtTokens(s.cumulativeCacheReadTokens) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#10060; ' + STR.cacheMiss + '</div><div class="value">' + fmtTokens(s.cumulativeInputTokens) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#128200; ' + STR.hitRate + '</div><div class="value">' + cumHitRate + '</div></div>' +
      '<div class="stat-card"><div class="label">&#128228; ' + STR.outputTokens + '</div><div class="value">' + fmtTokens(s.cumulativeOutputTokens) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#9203; ' + STR.turnAiTime + '</div><div class="value turn-ai">' + fmtThink(s.turnAiTimeMs) + '</div></div>' +
    '</div>';
  }

  // Agent filter (all / main only / sub only)
  var visibleMsgs = allMsgs;
  if (currentAgentFilter === 'main') {
    visibleMsgs = allMsgs.filter(function(m) { return m.source !== 'subagent'; });
  } else if (currentAgentFilter === 'sub') {
    visibleMsgs = allMsgs.filter(function(m) { return m.source === 'subagent'; });
  }

  var html =
    '<div class="header">' +
      '<h2>' + esc(s.title) + '</h2>' +
      '<div class="meta">' + STR.lastModel + ': ' + esc(s.model) + ' | ' + s.messageCount + ' ' + STR.messagesCount + '</div>' +
    '</div>' +
    statsHtml + agentSplitHtml + modelStatsHtml + agentBreakdownHtml +
    '<div class="table-container"><table>' +
      '<thead><tr><th>#</th><th>' + STR.type + '</th><th>' + STR.modelLabel + '</th><th>' + STR.totalInput + '</th><th>' + STR.cacheHits + '</th><th>' + STR.cacheMiss + '</th><th>' + STR.output + '</th><th>' + STR.hitRate + '</th><th>' + STR.cost + '</th><th>' + STR.thinking + '</th></tr></thead>' +
      '<tbody>' +
        (visibleMsgs.length === 0
          ? '<tr class="empty-row"><td colspan="10">&mdash;</td></tr>'
          : visibleMsgs.map(function(m, i) {
          var isSub = m.source === 'subagent';
          var cls = m.isUserMessage ? 'row-user' : (isSub ? 'row-assistant row-subagent' : 'row-assistant');
          var type = m.isUserMessage ? STR.user : (isSub ? STR.subagent : STR.mainAgent);
          var chip = isSub ? '<span class="agent-chip">' + esc(m.agentLabel || (m.agentId || '').slice(0, 8) || '?') + '</span>' : '';
          var time = fmtTime(m.timestamp);
          var totIn = m.isUserMessage ? 0 : (m.inputTokens + m.cacheReadTokens);
          var hitRate = m.isUserMessage ? '-' : (totIn > 0 ? (m.cacheReadTokens / totIn * 100).toFixed(1) + '%' : '0%');
          return '<tr class="' + cls + '">' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + type + chip + ' <span class="cell-time" style="font-size:9px;color:var(--muted)">' + time + '</span></td>' +
            '<td>' + (m.isUserMessage ? '-' : esc(m.model || '-')) + '</td>' +
            '<td>' + (m.isUserMessage ? '-' : fmtTokens(totIn)) + '</td>' +
            '<td>' + (m.isUserMessage ? '-' : fmtTokens(m.cacheReadTokens)) + '</td>' +
            '<td>' + (m.isUserMessage ? '-' : fmtTokens(m.inputTokens)) + '</td>' +
            '<td>' + (m.isUserMessage ? '-' : fmtTokens(m.outputTokens)) + '</td>' +
            '<td>' + hitRate + '</td>' +
            '<td>' + (m.isUserMessage ? '-' : (m.costKnown === false ? '—' : fmtCost(m.costDisplay != null ? m.costDisplay : m.costCNY))) + '</td>' +
            '<td><span class="think-time">' + fmtThink(m.thinkingTimeMs) + '</span></td>' +
          '</tr>';
        }).join('')) +
      '</tbody></table></div>' +
    '<div class="footer">' + STR.autoRefresh.replace('{0}', String(Math.round(currentPollMs/1000))) +
      ' <button id="pauseBtn" class="pause-btn" data-action="toggle-pause">' + STR.pauseRefresh + '</button>' +
    '</div>';

  document.getElementById('app').innerHTML = html;

  // Restore expanded model details
  for (var j = 0; j < expandedModels.length; j++) {
    var el2 = document.getElementById('modelDetail-' + expandedModels[j]);
    if (el2) el2.style.display = 'block';
  }

  // Table: always scroll to bottom on refresh (unless paused, which skips renderFull entirely)
  var container2 = document.querySelector('.table-container');
  if (container2) container2.scrollTop = container2.scrollHeight;

  // Update filter bar state in-place
  updateSessionDropdown();
  updateFilterUI();
}

function renderAggregated(a) {
  var totalInput = a.inputTokens;
  var hitRate = totalInput > 0 ? (a.cacheHits / totalInput * 100).toFixed(1) + '%' : '0%';

  // Build stats cards — either aggregate or per-model
  var statsHtml = '';
  if (isGroupByModel && a.modelStats && a.modelStats.length > 0) {
    statsHtml = a.modelStats.map(function(ms) {
      var mHitRate = ms.inputTokens > 0 ? (ms.cacheHits / ms.inputTokens * 100).toFixed(1) + '%' : '0%';
      return '<div style="margin-bottom:6px">' +
        '<div style="font-weight:600;margin-bottom:4px;color:var(--accent2);font-size:11px">' + esc(ms.model) + ' - ' + fmtCost(ms.cost) + '</div>' +
        '<div class="model-detail-grid">' +
          '<div class="stat-card"><div class="label">&#128230; ' + STR.totalTokens + '</div><div class="value">' + fmtTokens(ms.tokens) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#128176; ' + STR.totalCost + '</div><div class="value cost">' + fmtCost(ms.cost) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#128229; ' + STR.totalInput + '</div><div class="value">' + fmtTokens(ms.inputTokens) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#9989; ' + STR.cacheHits + '</div><div class="value">' + fmtTokens(ms.cacheHits) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#10060; ' + STR.cacheMiss + '</div><div class="value">' + fmtTokens(ms.cacheMiss) + '</div></div>' +
          '<div class="stat-card"><div class="label">&#128200; ' + STR.hitRate + '</div><div class="value">' + mHitRate + '</div></div>' +
          '<div class="stat-card"><div class="label">&#128228; ' + STR.output + '</div><div class="value">' + fmtTokens(ms.outputTokens) + '</div></div>' +
        '</div>' +
      '</div>';
    }).join('');
  } else {
    var sc = STR.aggSessionsCount.replace('{0}', String(a.sessionCount));
    statsHtml = '<div class="stats-grid">' +
      '<div class="stat-card"><div class="label">&#128230; ' + STR.totalTokens + '</div><div class="value">' + fmtTokens(a.totalTokens) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#128176; ' + STR.totalCost + '</div><div class="value cost">' + fmtCost(a.totalCost) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#128229; ' + STR.totalInput + '</div><div class="value">' + fmtTokens(a.inputTokens) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#9989; ' + STR.cacheHits + '</div><div class="value">' + fmtTokens(a.cacheHits) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#10060; ' + STR.cacheMiss + '</div><div class="value">' + fmtTokens(a.cacheMiss) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#128200; ' + STR.hitRate + '</div><div class="value">' + hitRate + '</div></div>' +
      '<div class="stat-card"><div class="label">&#128228; ' + STR.outputTokens + '</div><div class="value">' + fmtTokens(a.outputTokens) + '</div></div>' +
      '<div class="stat-card"><div class="label">&#128179; ' + esc(sc) + '</div><div class="value">' + a.sessionCount + '</div></div>' +
    '</div>';
  }

  // Session summary table
  var headerHtml = '<div class="header"><h2>' + esc(STR.filterAllSessions) + '</h2>' +
    '<div class="meta">' + STR.aggSessionsCount.replace('{0}', String(a.sessionCount)) + ' | ' + a.messageCount + ' ' + STR.messagesCount + '</div></div>';

  var rowsHtml = '';
  if (a.sessions && a.sessions.length > 0) {
    rowsHtml = a.sessions.map(function(s) {
      var d = new Date(s.startedAt);
      var dateStr = d.toLocaleDateString(currentLang === 'zh-CN' ? 'zh-CN' : 'en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      return '<tr class="session-summary-row" data-sid="' + esc(s.sessionId) + '" style="cursor:pointer">' +
        '<td>' + esc(s.title) + '</td>' +
        '<td>' + s.messageCount + '</td>' +
        '<td>' + fmtTokens(s.totalInputTokens + s.totalOutputTokens + s.totalCacheHitTokens + s.totalCacheMissTokens + (s.totalCacheCreationTokens || 0)) + '</td>' +
        '<td>' + fmtCost(s.totalCostCNY) + '</td>' +
        '<td>' + esc(s.primaryModel) + '</td>' +
        '<td style="font-size:9px;color:var(--muted)">' + dateStr + '</td>' +
      '</tr>';
    }).join('');
  } else {
    rowsHtml = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px">' + STR.aggNoSessions + '</td></tr>';
  }

  var html = headerHtml + statsHtml +
    '<div class="table-container"><table>' +
    '<thead><tr><th>' + (STR.filterSelectSession || 'Session') + '</th><th>' + STR.messagesCount + '</th><th>' + STR.totalTokens + '</th><th>' + STR.totalCost + '</th><th>' + STR.modelLabel + '</th><th>Time</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table></div>' +
    '<div class="footer">' + STR.autoRefresh.replace('{0}', String(Math.round(currentPollMs/1000))) +
      ' <button id="pauseBtn" class="pause-btn" data-action="toggle-pause">' + STR.pauseRefresh + '</button>' +
    '</div>';

  document.getElementById('app').innerHTML = html;
  updateSessionDropdown();
  updateFilterUI();

  // Event delegation for session summary rows
  var appEl = document.getElementById('app');
  if (appEl) {
    appEl.onclick = function(e) {
      var row = e.target.closest ? e.target.closest('.session-summary-row') : null;
      if (row) {
        var sid = row.getAttribute('data-sid');
        if (sid) selectSession(sid);
      }
    };
  }
}
</script>
</body>
</html>`;
  }
}
