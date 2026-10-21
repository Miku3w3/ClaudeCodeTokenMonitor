import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sortChronologically, recentMessages, buildAgentStats } = require('../out/core/agentView.js');

function msg(overrides = {}) {
  return {
    uuid: overrides.uuid || 'u',
    timestamp: overrides.timestamp || '2026-10-21T01:00:00.000Z',
    isUserMessage: false,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    model: 'deepseek-v4.1-flash-1017', costCNY: 0, costKnown: true,
    ...overrides,
  };
}

test('sortChronologically orders by timestamp without mutating the input', () => {
  const input = [
    msg({ uuid: 'b', timestamp: '2026-10-21T01:00:20.000Z' }),
    msg({ uuid: 'a', timestamp: '2026-10-21T01:00:10.000Z' }),
  ];
  const sorted = sortChronologically(input);
  assert.deepEqual(sorted.map((m) => m.uuid), ['a', 'b']);
  assert.deepEqual(input.map((m) => m.uuid), ['b', 'a'], 'input order untouched');
});

test('recentMessages keeps the newest window even when main was appended first', () => {
  // Reproduces the live accumulator order: every main message, then every subagent message.
  const main = Array.from({ length: 5 }, (_, i) =>
    msg({ uuid: `main-${i}`, timestamp: `2026-10-21T01:00:0${i}.000Z`, source: 'main' }));
  const sub = Array.from({ length: 20 }, (_, i) =>
    msg({ uuid: `sub-${i}`, timestamp: `2026-10-21T01:01:${String(i).padStart(2, '0')}.000Z`, source: 'subagent' }));
  const recent = recentMessages([...main, ...sub], 10);
  assert.ok(recent.length >= 10 && recent.length <= 11, 'window size stays bounded');
  assert.ok(recent.some((m) => m.source === 'main'), 'main messages survive the window');
  assert.equal(recent[0].source, 'main', 'the latest main response is kept at the top');
  for (let i = 1; i < recent.length; i++) {
    assert.ok(Date.parse(recent[i - 1].timestamp) <= Date.parse(recent[i].timestamp), 'chronological');
  }
});

test('recentMessages returns everything when the list is short and respects limit 0', () => {
  const list = [msg({ uuid: 'a' }), msg({ uuid: 'b' })];
  assert.equal(recentMessages(list, 200).length, 2);
  assert.equal(recentMessages(list, 0).length, 0);
});

test('buildAgentStats splits main and subagent usage and lists each subagent', () => {
  const list = [
    msg({ uuid: 'u1', isUserMessage: true }),
    msg({ uuid: 'm1', source: 'main', costCNY: 0.9, inputTokens: 100, outputTokens: 10 }),
    msg({ uuid: 's1', source: 'subagent', agentId: 'agent-b', agentLabel: 'agent-b', costCNY: 0.5, inputTokens: 200, outputTokens: 20 }),
    msg({ uuid: 's2', source: 'subagent', agentId: 'agent-b', agentLabel: 'agent-b', costCNY: 0.1, inputTokens: 50, outputTokens: 5 }),
    msg({ uuid: 's3', source: 'subagent', agentId: 'agent-a', agentLabel: 'agent-a', costCNY: 0.2, inputTokens: 30, outputTokens: 3 }),
  ];
  const stats = buildAgentStats(list);
  assert.deepEqual(stats.main, { cost: 0.9, tokens: 110, messages: 1 });
  assert.equal(stats.sub.messages, 3);
  assert.equal(Math.round(stats.sub.tokens), 308);
  assert.equal(stats.agents.length, 2);
  assert.deepEqual(stats.agents.map((a) => a.id), ['agent-b', 'agent-a'], 'most expensive first');
  assert.equal(stats.agents[0].messages, 2);
});

test('buildAgentStats applies the display-currency converter', () => {
  const stats = buildAgentStats(
    [msg({ source: 'main', costCNY: 10 }), msg({ source: 'subagent', agentId: 'x', costCNY: 5 })],
    (cny) => cny / 7,
  );
  assert.equal(stats.main.cost, 10 / 7);
  assert.equal(stats.sub.cost, 5 / 7);
});

test('buildAgentStats never produces NaN and tolerates missing fields', () => {
  const broken = msg({
    source: 'subagent', agentId: undefined, agentLabel: undefined,
    costCNY: NaN, inputTokens: undefined, outputTokens: undefined,
    cacheReadTokens: undefined, cacheCreationTokens: undefined,
  });
  const stats = buildAgentStats([broken, msg({ source: 'main', costCNY: undefined })]);
  assert.ok(Number.isFinite(stats.sub.cost) && Number.isFinite(stats.main.cost));
  assert.equal(stats.sub.tokens, 0);
  assert.equal(stats.agents[0].id, 'unknown');
});

test('messages without a source count as the main agent', () => {
  const stats = buildAgentStats([msg({ costCNY: 1, inputTokens: 10 })]);
  assert.equal(stats.main.messages, 1);
  assert.equal(stats.sub.messages, 0);
});