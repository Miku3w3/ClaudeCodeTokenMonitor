import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TranscriptTailer } = require('../out/core/transcriptTailer.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctm-tailer-'));
let counter = 0;

function tempFile() {
  counter++;
  return path.join(tmpDir, `transcript-${counter}.jsonl`);
}

function line(uuid, timestamp, output = 1) {
  return JSON.stringify({
    type: 'assistant', uuid, sessionId: 's', timestamp,
    message: { id: uuid, role: 'assistant', model: 'deepseek-v4.1-flash', usage: { input_tokens: 10, output_tokens: output } },
  });
}

test('tailer emits complete lines only and buffers the trailing partial line', () => {
  const file = tempFile();
  const first = line('a', '2026-10-21T02:00:00.000Z');
  const second = line('b', '2026-10-21T02:00:01.000Z');
  fs.writeFileSync(file, first + '\n' + second.slice(0, 20), 'utf-8');

  const tailer = new TranscriptTailer();
  const result = tailer.read(file);
  assert.equal(result.missing, false);
  assert.equal(result.truncated, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].uuid, 'a');
  assert.ok(tailer.pendingBytes > 0);

  fs.appendFileSync(file, second.slice(20) + '\n', 'utf-8');
  const next = tailer.read(file);
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].uuid, 'b');
  assert.equal(tailer.pendingBytes, 0);
});

test('tailer detects truncation and replays from byte zero', () => {
  const file = tempFile();
  fs.writeFileSync(file, line('a', '2026-10-21T02:00:00.000Z') + '\n' + line('b', '2026-10-21T02:00:01.000Z') + '\n', 'utf-8');
  const tailer = new TranscriptTailer();
  assert.equal(tailer.read(file).events.length, 2);

  const replacement = line('c', '2026-10-21T02:00:02.000Z') + '\n';
  fs.writeFileSync(file, replacement, 'utf-8');
  const result = tailer.read(file);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.events.map(e => e.uuid), ['c']);
  assert.equal(tailer.position, Buffer.byteLength(replacement));
});

test('tailer reset forces a full reread', () => {
  const file = tempFile();
  fs.writeFileSync(file, line('a', '2026-10-21T02:00:00.000Z') + '\n', 'utf-8');
  const tailer = new TranscriptTailer();
  assert.equal(tailer.read(file).events.length, 1);
  assert.equal(tailer.read(file).events.length, 0);
  tailer.reset();
  assert.equal(tailer.read(file).events.length, 1);
});

test('tailer reports missing files without throwing', () => {
  const tailer = new TranscriptTailer();
  const result = tailer.read(path.join(tmpDir, 'does-not-exist.jsonl'));
  assert.equal(result.missing, true);
  assert.deepEqual(result.events, []);
});

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});