/**
 * Renders the DetailPanel webview script against a stub DOM and checks the
 * v1.3.0 main/subagent split UI: split strip, type column, agent chip,
 * breakdown table and the agent filter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// DetailPanel imports 'vscode', which only exists inside VS Code.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') {
    return { Uri: {}, window: {}, workspace: {}, commands: {}, EventEmitter: class {} };
  }
  return originalLoad.apply(this, arguments);
};
const { DetailPanel } = require('../out/ui/DetailPanel.js');
Module._load = originalLoad;

const STRINGS = {
  'panel.noSession': 'No active session',
  'panel.noSessionHint': 'Start a conversation',
  'panel.type': 'Type', 'panel.user': 'User', 'panel.ai': 'AI',
  'panel.mainAgent': 'Main', 'panel.subagent': 'Sub',
  'panel.agentSplit': 'Agent split', 'panel.agentBreakdown': 'Subagents',
  'panel.filter.allAgents': 'All agents', 'panel.filter.mainOnly': 'Main only',
  'panel.filter.subOnly': 'Sub only',
  'panel.input': 'Input', 'panel.cache': 'Cache', 'panel.output': 'Output',
  'panel.cost': 'Cost', 'panel.thinking': 'Think',
  'panel.settings': 'Settings', 'panel.pauseRefresh': 'Pause', 'panel.resumeRefresh': 'Resume',
  'tooltip.lastModel': 'Last model', 'tooltip.model': 'Model', 'tooltip.totalInput': 'Input (total)',
  'tooltip.cacheMiss': 'Cache miss', 'tooltip.hitRate': 'Hit rate',
  'panel.filter.currentSession': 'Current', 'panel.filter.daily': 'Daily',
  'panel.filter.weekly': 'Weekly', 'panel.filter.monthly': 'Monthly',
  'panel.filter.yearly': 'Yearly', 'panel.filter.all': 'All',
  'panel.filter.selectSession': 'Select Session', 'panel.filter.byModel': 'By Model',
  'panel.filter.allSessions': 'All Sessions',
  'panel.aggregate.sessionsCount': '{0} sessions', 'panel.aggregate.noSessions': 'No sessions',
  'panel.totalTokens': 'Total Tokens', 'panel.totalCost': 'Total Cost',
  'panel.inputTokens': 'Input', 'panel.cacheHits': 'Cache hits',
  'panel.outputTokens': 'Output', 'panel.messagesCount': 'messages',
  'panel.autoRefresh': 'Auto-refresh every {0}s', 'panel.turnAiTime': 'Turn AI time',
};

function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', value: '',
    style: { display: '' },
    options: [],
    classList: { add() {}, remove() {} },
    getAttribute() { return null; },
    closest() { return null; },
    appendChild() {},
  };
}

/** Boot the webview script with a stub DOM and return its internal handles. */
function bootWebview() {
  const panel = new DetailPanel(() => ({
    t: (key) => STRINGS[key] || `??${key}??`,
    lang: 'zh-CN',
    currency: 'CNY',
    isRTL: false,
  }));
  const html = panel.getHtml();
  const match = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(match, 'webview script block is present');

  const elements = new Map();
  const appEl = makeEl('app');
  elements.set('app', appEl);
  const documentStub = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => {
      const el = { textContent: '' };
      Object.defineProperty(el, 'innerHTML', {
        get() {
          return String(el.textContent)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
      });
      return el;
    },
    addEventListener() {},
  };
  const windowStub = { addEventListener() {} };
  const vscodeStub = { postMessage() {}, getState() {}, setState() {} };

  const factory = new Function(
    'document', 'window', 'acquireVsCodeApi',
    `${match[1]}\nreturn { renderFull, setAgentFilter: function (v) { currentAgentFilter = v; } };`,
  );
  const api = factory(documentStub, windowStub, () => vscodeStub);
  return { api, appEl, pageHtml: html };
}

function sampleSession() {
  return {
    sessionId: 's1', title: 'Test', model: 'deepseek-v4.1-flash', isActive: true,
    cumulativeInputTokens: 100000, cumulativeOutputTokens: 20000,
    cumulativeCacheReadTokens: 500000, cumulativeCostCNY: 1.5,
    totalTokens: 620000, messageCount: 3, turnAiTimeMs: 12000,
    messages: [
      {
        uuid: 'u1', timestamp: '2026-10-21T01:00:00Z', isUserMessage: true,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        model: '', costCNY: 0, source: 'main',
      },
      {
        uuid: 'a1', timestamp: '2026-10-21T01:00:10Z', isUserMessage: false,
        inputTokens: 50000, outputTokens: 10000, cacheReadTokens: 400000,
        cacheCreationTokens: 0, model: 'deepseek-v4.1-flash',
        costCNY: 0.9, costDisplay: 0.9, costKnown: true, thinkingTimeMs: 10000,
        source: 'main',
      },
      {
        uuid: 'a2', timestamp: '2026-10-21T01:00:20Z', isUserMessage: false,
        inputTokens: 50000, outputTokens: 10000, cacheReadTokens: 100000,
        cacheCreationTokens: 0, model: 'deepseek-v4.1-flash',
        costCNY: 0.6, costDisplay: 0.6, costKnown: true, thinkingTimeMs: 5000,
        source: 'subagent', agentId: 'abcdef123456', agentLabel: 'abcdef12',
      },
    ],
    modelStats: [{
      model: 'deepseek-v4.1-flash', tokens: 620000, cost: 1.5,
      inputTokens: 150000, cacheHits: 500000, cacheMiss: 100000, outputTokens: 20000,
    }],
    lastUpdatedAt: '2026-10-21T01:00:21Z',
  };
}

const countRows = (html) => (html.match(/<tr /g) || []).length;

test('split strip reports the subagent share of cost', () => {
  const { api, appEl } = bootWebview();
  api.renderFull(sampleSession());
  const html = appEl.innerHTML;
  assert.ok(html.includes('Agent split'), 'split strip present');
  assert.ok(html.includes('Sub 40.0%'), 'sub share is 0.6 / 1.5 = 40%');
  assert.ok(html.includes('Main') && html.includes('Sub'), 'both legend labels present');
});

test('type column splits main agent from subagent and shows the agent chip', () => {
  const { api, appEl } = bootWebview();
  api.renderFull(sampleSession());
  const html = appEl.innerHTML;
  assert.ok(html.includes('agent-chip'), 'agent chip rendered');
  assert.ok(html.includes('abcdef12'), 'agent label rendered');
  assert.ok(html.includes('row-subagent'), 'subagent row class applied');
  assert.ok(html.includes('>Main') || html.includes('>Main<'), 'main agent type label');
});

test('breakdown lists each subagent once', () => {
  const { api, appEl } = bootWebview();
  api.renderFull(sampleSession());
  const html = appEl.innerHTML;
  assert.ok(html.includes('Subagents (1)'), 'one subagent in the breakdown button');
  assert.ok(html.includes('agent-breakdown'), 'breakdown table rendered');
});

test('agent filter narrows the table to sub or main rows', () => {
  const { api, appEl } = bootWebview();
  api.renderFull(sampleSession());
  assert.equal(countRows(appEl.innerHTML), 3, 'all rows by default');

  api.setAgentFilter('sub');
  api.renderFull(sampleSession());
  assert.equal(countRows(appEl.innerHTML), 1, 'sub filter shows one row');
  assert.ok(appEl.innerHTML.includes('row-subagent'));

  api.setAgentFilter('main');
  api.renderFull(sampleSession());
  assert.equal(countRows(appEl.innerHTML), 2, 'main filter shows two rows');
  assert.ok(!appEl.innerHTML.includes('row-subagent'));
});

test('sessions without subagents keep the old minimal layout', () => {
  const { api, appEl } = bootWebview();
  const session = sampleSession();
  session.messages = session.messages.filter((m) => m.source !== 'subagent');
  api.renderFull(session);
  const html = appEl.innerHTML;
  assert.ok(!html.includes('Agent split'), 'no split strip without subagents');
  assert.ok(!html.includes('agent-breakdown'), 'no breakdown without subagents');
  assert.equal(countRows(html), 2);
});

test('sub-only filter on a session without subagents shows an empty state', () => {
  const { api, appEl } = bootWebview();
  const session = sampleSession();
  session.messages = session.messages.filter((m) => m.source !== 'subagent');
  api.setAgentFilter('sub');
  api.renderFull(session);
  const html = appEl.innerHTML;
  assert.equal(countRows(html), 1);
  assert.ok(html.includes('empty-row'));
});

test('agentStats drives the split even when the table window holds only subagents', () => {
  const { api, appEl } = bootWebview();
  const session = sampleSession();
  // The live accumulator appends main first and subagents later, so a truncated
  // window can contain subagent rows only. The split must not follow that window.
  session.messages = session.messages.filter((m) => m.source === 'subagent');
  session.agentStats = {
    main: { cost: 0.9, tokens: 460000, messages: 1 },
    sub: { cost: 0.6, tokens: 160000, messages: 1 },
    agents: [{ id: 'abcdef123456', label: 'abcdef12', cost: 0.6, tokens: 160000, messages: 1 }],
  };
  api.renderFull(session);
  const html = appEl.innerHTML;
  assert.ok(html.includes('Sub 40.0%'), 'share comes from agentStats');
  assert.ok(html.includes('0.9000'), 'main cost comes from agentStats, not the window');
  assert.ok(html.includes('Subagents (1)'), 'breakdown comes from agentStats');
  assert.ok(!html.includes('0.0000'), 'main is never reported as zero');
});

test('agentStats suppresses the split when the session had no subagents', () => {
  const { api, appEl } = bootWebview();
  const session = sampleSession();
  session.messages = session.messages.filter((m) => m.source !== 'subagent');
  session.agentStats = {
    main: { cost: 1.5, tokens: 620000, messages: 2 },
    sub: { cost: 0, tokens: 0, messages: 0 },
    agents: [],
  };
  api.renderFull(session);
  assert.ok(!appEl.innerHTML.includes('Agent split'));
});

test('split bar colours: main green, subagent purple', () => {
  const { pageHtml } = bootWebview();
  assert.ok(pageHtml.includes('--sub: var(--vscode-charts-purple'), 'purple subagent variable');
  assert.ok(pageHtml.includes('.agent-bar-main { background: var(--accent);'), 'main bar uses green accent');
  assert.ok(pageHtml.includes('.agent-bar-sub { background: var(--sub);'), 'sub bar uses purple');
  assert.ok(pageHtml.includes('color: var(--sub);'), 'subagent chip/row use purple');
});