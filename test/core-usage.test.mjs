import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  finiteNumber,
  normalizeUsage,
  isBetterSnapshot,
  groupUsageSnapshots,
  usageTotal,
} = require('../out/core/usage.js');
const { JsonlLineBuffer } = require('../out/core/lineBuffer.js');
const { replayTranscriptLines } = require('../out/core/replay.js');
const pricing = require('../out/model/pricing.js');

function userLine(timestamp, text = 'hello') {
  return JSON.stringify({
    type: 'user', uuid: `user-${timestamp}`, sessionId: 's',
    timestamp, message: { role: 'user', content: text },
  });
}

function assistantLine({ uuid, messageId, timestamp, usage, model = 'deepseek-v4.1-flash-1017' }) {
  return JSON.stringify({
    type: 'assistant', uuid, sessionId: 's', timestamp,
    message: { id: messageId, role: 'assistant', model, usage },
  });
}

test('finiteNumber never yields NaN or negatives', () => {
  assert.equal(finiteNumber(undefined), 0);
  assert.equal(finiteNumber(null), 0);
  assert.equal(finiteNumber(NaN), 0);
  assert.equal(finiteNumber(Infinity), 0);
  assert.equal(finiteNumber(-5), 0);
  assert.equal(finiteNumber('42'), 42);
  assert.equal(finiteNumber(0.5), 0.5);
});

test('normalizeUsage treats missing cache fields as zero', () => {
  const usage = normalizeUsage({ input_tokens: 100, output_tokens: 20 });
  assert.deepEqual(usage, {
    inputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 20,
  });
  assert.equal(usageTotal(usage), 120);
});

test('the trailing zero-output placeholder never replaces a real snapshot', () => {
  const real = normalizeUsage({
    input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50,
  });
  const placeholder = normalizeUsage({ input_tokens: 100, output_tokens: 0 });
  assert.equal(isBetterSnapshot(real, placeholder), true);
  assert.equal(isBetterSnapshot(placeholder, real), false);
});

test('groupUsageSnapshots keeps one record per message.id with max output', () => {
  const records = [
    { uuid: 'u1', messageId: 'm1', usage: normalizeUsage({ input_tokens: 100, output_tokens: 0 }) },
    { uuid: 'u2', messageId: 'm1', usage: normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 }) },
    { uuid: 'u3', messageId: 'm1', usage: normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 0 }) },
    { uuid: 'u4', messageId: 'm2', usage: normalizeUsage({ input_tokens: 7, output_tokens: 3 }) },
  ];
  const grouped = groupUsageSnapshots(records);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].messageId, 'm1');
  assert.equal(grouped[0].usage.outputTokens, 50);
  assert.equal(grouped[0].usage.cacheReadTokens, 900);
  const totalInput = grouped.reduce((sum, r) => sum + r.usage.inputTokens, 0);
  assert.equal(totalInput, 107); // NOT 300 from all streaming lines
});

test('JsonlLineBuffer only emits complete lines and survives split UTF-8', () => {
  const buffer = new JsonlLineBuffer();
  const full = Buffer.from('{"text":"¥"}\n', 'utf-8');
  // Split inside the three-byte ¥ character.
  const first = full.subarray(0, 8);
  const second = full.subarray(8);

  assert.deepEqual(buffer.push(first), []);
  assert.ok(buffer.pendingBytes > 0);
  const lines = buffer.push(second);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { text: '¥' });
  assert.equal(buffer.pendingBytes, 0);
});

test('JsonlLineBuffer keeps a trailing partial line across chunks', () => {
  const buffer = new JsonlLineBuffer();
  assert.deepEqual(buffer.push(Buffer.from('{"a":1}\n{"b":')), ['{"a":1}']);
  assert.deepEqual(buffer.push(Buffer.from('2}\n{"c":3}\n')), ['{"b":2}', '{"c":3}']);
  buffer.reset();
  assert.equal(buffer.pendingBytes, 0);
});

test('unknown models resolve to null, never to the most expensive model', () => {
  assert.equal(pricing.resolvePricing('totally-unknown-model-xyz'), null);
  const detail = pricing.calculateCostDetail('totally-unknown-model-xyz', {
    inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000,
  }, Date.now());
  assert.equal(detail.known, false);
  assert.equal(detail.amount, 0);
  assert.equal(pricing.calculateCost('totally-unknown-model-xyz', 1_000_000, 0, 1_000_000), 0);
});

test('dated Bailian snapshot names resolve through aliases/prefixes', () => {
  const now = Date.UTC(2026, 9, 21, 2, 0); // 10:00 Beijing, Wednesday (peak)
  const flash = pricing.resolvePricing('deepseek-v4.1-flash-1017[1m]');
  assert.ok(flash);
  assert.equal(flash.matchedModel, 'deepseek-v4.1-flash');
  assert.equal(flash.currency, 'CNY');
  assert.equal(flash.cacheMiss, 2);
  assert.equal(flash.output, 8);

  const pro813 = pricing.resolvePricing('deepseek-v4-pro-0813');
  assert.ok(pro813);
  assert.equal(pro813.matchedModel, 'deepseek-v4-pro-0813');
  assert.equal(pro813.cacheMiss, 9);
  assert.equal(pro813.output, 27);

  const detail = pricing.calculateCostDetail('deepseek-v4.1-flash-1017', {
    inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000,
  }, now);
  assert.equal(detail.known, true);
  assert.equal(detail.amount, 10); // 2 + 8, definitely not r1's 20
});

test('DeepSeek off-peak pricing applies outside workday hours', () => {
  const peak = Date.UTC(2026, 9, 21, 2, 0);     // Wed 10:00 Beijing
  const offPeak = Date.UTC(2026, 9, 20, 19, 0); // Wed 03:00 Beijing
  const weekend = Date.UTC(2026, 9, 24, 2, 0);  // Sat 10:00 Beijing

  assert.equal(pricing.isDeepSeekOffPeak(peak), false);
  assert.equal(pricing.isDeepSeekOffPeak(offPeak), true);
  assert.equal(pricing.isDeepSeekOffPeak(weekend), true);

  const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000 };
  assert.equal(pricing.calculateCostDetail('deepseek-v4.1-flash-1017', usage, peak).amount, 10);
  assert.equal(pricing.calculateCostDetail('deepseek-v4.1-flash-1017', usage, offPeak).amount, 5);
});

test('cache creation tokens are charged at the cache-write price', () => {
  const peak = Date.UTC(2026, 9, 21, 2, 0);
  const detail = pricing.calculateCostDetail('deepseek-v4.1-flash', {
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 1_000_000,
    outputTokens: 1_000_000,
  }, peak);
  assert.equal(detail.amount, 12); // 2 input + 2 cache write (same as miss) + 8 output
});

test('custom models participate in cost calculation', () => {
  const custom = [{
    name: 'Mine', matchPattern: 'my-private-model',
    cacheHit: 0.1, cacheMiss: 1, output: 2, currency: 'USD',
  }];
  const resolved = pricing.resolvePricing('my-private-model-v2', custom);
  assert.ok(resolved);
  assert.equal(resolved.currency, 'USD');
  assert.equal(resolved.providerName, 'Mine');
  const detail = pricing.calculateCostDetail('my-private-model-v2', {
    inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000,
  }, Date.now(), custom);
  assert.equal(detail.amount, 3);
  assert.equal(detail.currency, 'USD');
});

test('catalog sanitizer accepts the published nested schema', () => {
  const ok = pricing.setPricingCatalog({
    schemaVersion: 2,
    providers: [{
      id: 'test-provider',
      name: 'Test',
      currency: 'CNY',
      models: {
        'legacy-model': { input: { cacheHit: 0.5, cacheMiss: 1 }, output: 2 },
        'bad-model': { input: { cacheHit: null, cacheMiss: 'oops' }, output: null },
        'error': { input: { cacheHit: 1, cacheMiss: 1 }, output: 1 },
      },
    }],
  });
  assert.equal(ok, true);
  const resolved = pricing.resolvePricing('legacy-model');
  assert.ok(resolved);
  assert.equal(resolved.currency, 'CNY');
  const detail = pricing.calculateCostDetail('legacy-model', {
    inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000,
  }, Date.now());
  assert.equal(detail.amount, 3);
  assert.equal(pricing.resolvePricing('bad-model'), null);
  assert.equal(pricing.resolvePricing('error'), null);

  // Restore for other tests
  pricing.setPricingCatalog(pricing.BUILTIN_CATALOG);
  assert.ok(pricing.resolvePricing('deepseek-v4.1-flash'));
});

test('replayTranscriptLines counts each API response once and never produces NaN', () => {
  const lines = [
    userLine('2026-10-21T01:55:00.000Z'),
    assistantLine({
      uuid: 'a1', messageId: 'm1', timestamp: '2026-10-21T01:56:00.000Z',
      usage: { input_tokens: 1000, output_tokens: 0 },
    }),
    assistantLine({
      uuid: 'a2', messageId: 'm1', timestamp: '2026-10-21T01:57:00.000Z',
      usage: { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 40 },
    }),
    assistantLine({
      uuid: 'a3', messageId: 'm1', timestamp: '2026-10-21T01:58:00.000Z',
      usage: { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 0 },
    }),
    assistantLine({
      uuid: 'b1', messageId: 'm2', timestamp: '2026-10-21T01:59:00.000Z',
      usage: { input_tokens: 200, cache_creation_input_tokens: 300, output_tokens: 10 },
    }),
  ];

  const messages = replayTranscriptLines(lines);
  const assistants = messages.filter(m => !m.isUserMessage);
  assert.equal(messages.filter(m => m.isUserMessage).length, 1);
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].outputTokens, 40);
  assert.equal(assistants[0].cacheReadTokens, 5000);

  const sum = assistants.reduce((acc, m) => ({
    input: acc.input + m.inputTokens,
    output: acc.output + m.outputTokens,
    cacheRead: acc.cacheRead + m.cacheReadTokens,
    cacheCreation: acc.cacheCreation + m.cacheCreationTokens,
    cost: acc.cost + m.costCNY,
  }), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 });

  assert.deepEqual(sum, {
    input: 1200, output: 50, cacheRead: 5000, cacheCreation: 300,
    cost: sum.cost,
  });
  assert.ok(Number.isFinite(sum.cost));
  assert.ok(sum.cost > 0);
  for (const m of assistants) {
    for (const value of [m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheCreationTokens, m.costCNY]) {
      assert.ok(Number.isFinite(value));
    }
  }

  // Replaying twice yields exactly the same result (no state leaks).
  assert.deepEqual(replayTranscriptLines(lines), messages);
});

test('unknown models are marked unknown instead of priced by guesswork', () => {
  const lines = [
    userLine('2026-10-21T02:00:00.000Z'),
    assistantLine({
      uuid: 'x1', messageId: 'mx', timestamp: '2026-10-21T02:01:00.000Z',
      model: 'some-unreleased-model', usage: { input_tokens: 100, output_tokens: 10 },
    }),
  ];
  const messages = replayTranscriptLines(lines);
  const assistant = messages.find(m => !m.isUserMessage);
  assert.ok(assistant);
  assert.equal(assistant.costKnown, false);
  assert.equal(assistant.costCNY, 0);
  assert.ok(Number.isFinite(assistant.costCNY));
});

test('turn timing is based on the chosen (best) snapshot', () => {
  const lines = [
    userLine('2026-10-21T02:00:00.000Z'),
    assistantLine({
      uuid: 't1', messageId: 'mt1', timestamp: '2026-10-21T02:00:01.000Z',
      usage: { input_tokens: 10, output_tokens: 0 },
    }),
    assistantLine({
      uuid: 't2', messageId: 'mt1', timestamp: '2026-10-21T02:00:02.000Z',
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    JSON.stringify({
      type: 'user', uuid: 'tool-1', sessionId: 's', timestamp: '2026-10-21T02:00:03.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    }),
    assistantLine({
      uuid: 't3', messageId: 'mt2', timestamp: '2026-10-21T02:00:04.000Z',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ];
  const assistants = replayTranscriptLines(lines).filter(m => !m.isUserMessage);
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].thinkingTimeMs, 2000);
  assert.equal(assistants[0].turnAiTimeMs, 2000);
  assert.equal(assistants[1].thinkingTimeMs, 1000);
  assert.equal(assistants[1].turnAiTimeMs, 3000);
});