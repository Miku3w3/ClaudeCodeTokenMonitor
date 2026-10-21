import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { replayTranscriptLines } = require('../out/core/replay.js');
const { parseLine } = require('../out/parsers/TranscriptParser.js');

const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 10 };

function userLine(timestamp, extra = {}) {
  return JSON.stringify({
    type: 'user', uuid: `user-${timestamp}`, sessionId: 's', timestamp,
    message: { role: 'user', content: 'go' }, ...extra,
  });
}

function assistantLine({ uuid, messageId, timestamp, extra = {} }) {
  return JSON.stringify({
    type: 'assistant', uuid, sessionId: 's', timestamp,
    message: { id: messageId, role: 'assistant', model: 'deepseek-v4.1-flash-1017', usage: USAGE }, ...extra,
  });
}

test('parseLine keeps isSidechain and agentId from the JSONL line', () => {
  const event = parseLine(assistantLine({
    uuid: 'a1', messageId: 'm1', timestamp: '2026-10-21T01:00:00.000Z',
    extra: { isSidechain: true, agentId: 'agent-abc123' },
  }));
  assert.equal(event.type, 'assistant');
  assert.equal(event.isSidechain, true);
  assert.equal(event.agentId, 'agent-abc123');
});

test('main transcript lines carry no sidechain marker', () => {
  const event = parseLine(assistantLine({
    uuid: 'a1', messageId: 'm1', timestamp: '2026-10-21T01:00:00.000Z',
  }));
  assert.equal(event.isSidechain, undefined);
  assert.equal(event.agentId, undefined);
});

test('replayTranscriptLines defaults to the main source', () => {
  const stats = replayTranscriptLines([
    userLine('2026-10-21T01:00:00.000Z'),
    assistantLine({ uuid: 'a1', messageId: 'm1', timestamp: '2026-10-21T01:00:05.000Z' }),
  ]);
  assert.equal(stats.length, 2);
  for (const s of stats) {
    assert.equal(s.source, 'main');
    assert.equal(s.agentId, undefined);
  }
});

test('replayTranscriptLines tags every message with the subagent source', () => {
  const stats = replayTranscriptLines(
    [
      userLine('2026-10-21T01:00:00.000Z'),
      assistantLine({ uuid: 'a1', messageId: 'm1', timestamp: '2026-10-21T01:00:05.000Z' }),
      assistantLine({ uuid: 'a2', messageId: 'm2', timestamp: '2026-10-21T01:00:09.000Z' }),
    ],
    [],
    { kind: 'subagent', agentId: 'agent-abc123', agentLabel: 'abc12345' },
  );
  assert.equal(stats.length, 3);
  for (const s of stats) {
    assert.equal(s.source, 'subagent');
    assert.equal(s.agentId, 'agent-abc123');
  }
  const assistants = stats.filter((s) => !s.isUserMessage);
  assert.equal(assistants.length, 2);
  for (const s of assistants) assert.equal(s.agentLabel, 'abc12345');
});

test('streaming snapshots inside a subagent transcript still collapse to one entry', () => {
  const lines = [
    assistantLine({
      uuid: 'a1', messageId: 'same', timestamp: '2026-10-21T01:00:00.000Z',
      extra: { isSidechain: true, agentId: 'agent-x' },
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'a2', sessionId: 's', timestamp: '2026-10-21T01:00:03.000Z',
      isSidechain: true, agentId: 'agent-x',
      message: {
        id: 'same', role: 'assistant', model: 'deepseek-v4.1-flash-1017',
        usage: { ...USAGE, output_tokens: 200 },
      },
    }),
  ];
  const stats = replayTranscriptLines(lines, [], { kind: 'subagent', agentId: 'agent-x', agentLabel: 'agent-x' });
  assert.equal(stats.length, 1);
  assert.equal(stats[0].outputTokens, 200);
  assert.equal(stats[0].source, 'subagent');
});