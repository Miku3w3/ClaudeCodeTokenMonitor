import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function jsonl(lines) {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

function assistant(uuid, messageId, usage, timestamp, model = 'deepseek-v4.1-flash-1017') {
  return {
    type: 'assistant',
    uuid,
    sessionId: 'sess-1',
    timestamp,
    cwd: 'D:\\Jobs\\test-proj',
    message: { id: messageId, role: 'assistant', model, usage },
  };
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cctm-test-'));
const oldUserProfile = process.env.USERPROFILE;
const oldHome = process.env.HOME;
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const projectsDir = path.join(tmpHome, '.claude', 'projects', 'd--Jobs-test-proj');
const sessionId = 'sess-1';
const mainFile = path.join(projectsDir, `${sessionId}.jsonl`);
const nestedDir = path.join(projectsDir, sessionId, 'subagents');
const nestedFile = path.join(nestedDir, 'agent-x.jsonl');

fs.mkdirSync(nestedDir, { recursive: true });

fs.writeFileSync(mainFile, jsonl([
  {
    type: 'user', uuid: 'user-1', sessionId, cwd: 'D:\\Jobs\\test-proj',
    timestamp: '2026-10-21T01:55:00.000Z',
    message: { role: 'user', content: 'Hello title' },
  },
  assistant('a1', 'm1', { input_tokens: 1000, output_tokens: 0 }, '2026-10-21T01:56:00.000Z'),
  assistant('a2', 'm1', { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 40 }, '2026-10-21T01:57:00.000Z'),
  assistant('a3', 'm1', { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 0 }, '2026-10-21T01:58:00.000Z'),
  assistant('b1', 'm2', { input_tokens: 200, cache_creation_input_tokens: 300, output_tokens: 10 }, '2026-10-21T01:59:00.000Z'),
]), 'utf-8');

fs.writeFileSync(nestedFile, jsonl([
  assistant('c1', 'm3', { input_tokens: 50, cache_read_input_tokens: 25, output_tokens: 5 }, '2026-10-21T02:00:00.000Z'),
]), 'utf-8');

const SessionStore = require('../out/data/SessionStore.js');

test('scanAndIndex dedupes snapshots, includes subagents, and never stores NaN', () => {
  const index = SessionStore.scanAndIndex();
  const entry = index.sessions[sessionId];
  assert.ok(entry, 'session should be indexed');
  assert.equal(entry.messageCount, 3); // m1 + m2 + subagent m3
  assert.equal(entry.totalInputTokens, 1250);
  assert.equal(entry.totalOutputTokens, 55);
  assert.equal(entry.totalCacheHitTokens, 5025);
  assert.equal(entry.totalCacheCreationTokens, 300);
  assert.ok(Number.isFinite(entry.totalCostCNY));
  assert.ok(entry.totalCostCNY > 0);
  assert.equal(entry.cwd, 'D:\\Jobs\\test-proj');
  assert.equal(entry.title, 'Hello title');

  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'token-tracker', 'sessions.json'), 'utf-8'));
  assert.equal(onDisk.version, 4);
  assert.equal(onDisk.sessions[sessionId].totalCostCNY, entry.totalCostCNY);
});

test('rescanning an unchanged file is idempotent', () => {
  const before = SessionStore.scanAndIndex().sessions[sessionId];
  const after = SessionStore.scanAndIndex().sessions[sessionId];
  assert.equal(after.messageCount, before.messageCount);
  assert.equal(after.totalInputTokens, before.totalInputTokens);
  assert.equal(after.totalOutputTokens, before.totalOutputTokens);
  assert.equal(after.totalCostCNY, before.totalCostCNY);
});

test('a later, more complete snapshot replaces the earlier one instead of adding', () => {
  fs.appendFileSync(mainFile, jsonl([
    assistant('a4', 'm1', { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 60 }, '2026-10-21T02:01:00.000Z'),
  ]), 'utf-8');

  const entry = SessionStore.scanAndIndex().sessions[sessionId];
  assert.equal(entry.messageCount, 3);
  assert.equal(entry.totalOutputTokens, 75); // 40 → 60, plus 10 + 5
  assert.equal(entry.totalInputTokens, 1250);
  assert.ok(Number.isFinite(entry.totalCostCNY));
});

test.after(() => {
  if (oldUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldUserProfile;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});