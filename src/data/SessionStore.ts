/**
 * SessionStore — persistent index of every Claude Code session.
 *
 * Index layout: ~/.claude/token-tracker/sessions.json, schema v5.
 *
 * Correctness rules (see docs/audit/2026-10-21-audit-summary.md):
 *   • assistant lines are streaming snapshots sharing one message.id — keep the
 *     snapshot with the largest output_tokens, never sum every line;
 *   • missing cache fields are zero, never NaN;
 *   • subagent transcripts under <sessionId>/subagents/** belong to the parent
 *     session and must be scanned recursively;
 *   • cwd comes from the transcript's own `cwd` field, not from decoding the
 *     lossy encoded project folder name;
 *   • unknown models cost 0 and stay marked as unknown, never guessed.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { claudeDir, tokenTrackerDir } from '../utils/paths';
import type { SessionIndex, SessionIndexEntry, CustomModelConfig } from '../model/types';
import {
  normalizeModelName as normalizeModelNameFull,
  calculateCostDetail,
  convertCurrency,
  getPricingCatalog,
} from '../model/CostCalculator';
import { finiteNumber, normalizeUsage, isBetterSnapshot } from '../core/usage';

// ─── Public API ─────────────────────────────────────────────────

/** Bump this when the index schema changes or old data needs invalidation. */
const CURRENT_INDEX_VERSION = 5;

let index: SessionIndex | null = null;

/**
 * Fingerprint of the active price table.
 *
 * Per-session costs are cached in the index and the size/mtime check skips
 * unchanged transcripts forever, so a price change would otherwise never be
 * applied to history: the panel would keep showing the cost computed under the
 * catalog that happened to be active the first time the session was indexed.
 * The stamp covers the price table and the holiday list only — `updatedAt`
 * alone would trigger a full rescan on every no-op daily refresh.
 */
export function getPricingStamp(customModels: CustomModelConfig[] = []): string {
  const catalog = getPricingCatalog();
  const payload = JSON.stringify({
    providers: catalog.providers,
    holidays: catalog.holidays,
    customModels,
  });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** Load the index from disk. Returns an empty index if missing, corrupted, or stale. */
export function loadIndex(): SessionIndex {
  const cached = index;
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(indexPath(), 'utf-8');
    const parsed: SessionIndex = JSON.parse(raw);
    if (
      parsed
      && parsed.version === CURRENT_INDEX_VERSION
      && typeof parsed.updatedAt === 'number'
      && parsed.sessions !== undefined
    ) {
      index = parsed;
      return parsed;
    }
    console.log('[TokenMonitor] Stale index detected (v' + (parsed?.version || 0) + '), rebuilding...');
  } catch { /* file missing or corrupted — rebuild */ }
  const fresh: SessionIndex = { version: CURRENT_INDEX_VERSION, updatedAt: 0, pricingStamp: '', sessions: {} };
  index = fresh;
  return fresh;
}

/** Save the index atomically so a concurrently running window cannot read half a file. */
export function saveIndex(): void {
  if (!index) return;
  try { fs.mkdirSync(tokenTrackerDir(), { recursive: true }); } catch { /* */ }
  index.updatedAt = Date.now();
  const target = indexPath();
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(index, null, 2), 'utf-8');
    fs.renameSync(temp, target);
  } catch (err) {
    console.error('[TokenMonitor] Failed to save session index:', err);
    try { fs.unlinkSync(temp); } catch { /* ignore */ }
  }
}

/**
 * Scan all JSONL transcripts under ~/.claude/projects/ and rebuild the index.
 * Unchanged files (size + mtime match) are kept as-is.
 */
export function scanAndIndex(customModels: CustomModelConfig[] = []): SessionIndex {
  const idx = loadIndex();
  const projectsDir = path.join(claudeDir(), 'projects');
  const existingIds = new Set<string>();

  // Prices changed since the last scan → every cached cost is stale. Re-parse
  // all transcripts instead of trusting the size/mtime shortcut.
  const stamp = getPricingStamp(customModels);
  const pricesChanged = idx.pricingStamp !== stamp;
  if (pricesChanged && idx.pricingStamp) {
    console.log('[TokenMonitor] Pricing catalog changed, re-pricing the session index...');
  }

  let cwdDirs: fs.Dirent[];
  try { cwdDirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return idx; }

  for (const dir of cwdDirs) {
    if (!dir.isDirectory()) continue;
    const encoded = dir.name;
    const fallbackCwd = decodeProjectPath(encoded);
    const projectPath = path.join(projectsDir, encoded);

    let files: fs.Dirent[];
    try { files = fs.readdirSync(projectPath, { withFileTypes: true }); } catch { continue; }

    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const sessionId = f.name.replace(/\.jsonl$/, '');
      existingIds.add(sessionId);

      const allFiles = [path.join(projectPath, f.name)];
      const nestedDir = path.join(projectPath, sessionId, 'subagents');
      collectJsonlFiles(nestedDir, allFiles, 0);

      let fingerprint: { size: number; mtimeMs: number };
      try {
        fingerprint = fingerprintFiles(allFiles);
      } catch { continue; }

      const existing = idx.sessions[sessionId];
      if (
        !pricesChanged
        && existing
        && existing.fileSize === fingerprint.size
        && existing.fileMtimeMs === fingerprint.mtimeMs
        && Number.isFinite(existing.totalCostCNY)
      ) {
        continue;
      }

      const entry = parseSessionFiles(allFiles, sessionId, fallbackCwd, customModels);
      if (entry) {
        idx.sessions[sessionId] = entry;
      }
    }
  }

  // Drop sessions whose transcript files no longer exist
  for (const sid of Object.keys(idx.sessions)) {
    if (!existingIds.has(sid)) delete idx.sessions[sid];
  }

  index = idx;
  idx.pricingStamp = stamp;
  saveIndex();
  return index;
}

/** Update or create a single session in the index. */
export function upsertSession(
  sessionId: string,
  entry: Omit<SessionIndexEntry, 'lastUpdatedAt'> & { lastUpdatedAt?: number }
): void {
  const idx = loadIndex();
  idx.sessions[sessionId] = {
    ...entry,
    lastUpdatedAt: entry.lastUpdatedAt ?? Date.now(),
  };
  index = idx;
  saveIndex();
}

/** Return all sessions whose time range overlaps [startMs, endMs]. */
export function getSessionsInRange(startMs: number, endMs: number): SessionIndexEntry[] {
  const idx = loadIndex();
  return Object.values(idx.sessions).filter(s => s.lastUpdatedAt >= startMs && s.startedAt <= endMs);
}

/** Return all indexed sessions, sorted by lastUpdatedAt descending. */
export function getAllSessions(): SessionIndexEntry[] {
  const idx = loadIndex();
  return Object.values(idx.sessions).sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
}

/** Return a lightweight list for the webview session dropdown. */
export function getSessionList(): Array<{ sessionId: string; title: string; startedAt: number }> {
  return getAllSessions().map(s => ({
    sessionId: s.sessionId,
    title: s.title || s.slug || s.sessionId.slice(0, 8) + '...',
    startedAt: s.startedAt,
  }));
}

// ─── Internal helpers ───────────────────────────────────────────

function indexPath(): string {
  return path.join(tokenTrackerDir(), 'sessions.json');
}

/** Decode an encoded project path (fallback only; transcripts carry their own cwd). */
function decodeProjectPath(encoded: string): string {
  const idx = encoded.indexOf('--');
  if (idx >= 0) {
    const drive = encoded.slice(0, idx) + ':\\';
    const rest = encoded.slice(idx + 2).replace(/-/g, '\\');
    return drive + rest;
  }
  return '/' + encoded.replace(/-/g, '/');
}

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

function fingerprintFiles(files: string[]): { size: number; mtimeMs: number } {
  let size = 0;
  let mtimeMs = 0;
  for (const file of files) {
    const stat = fs.statSync(file);
    size += stat.size;
    if (stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
  }
  return { size, mtimeMs };
}

interface AssistantSnapshot {
  usage: ReturnType<typeof normalizeUsage>;
  model: string;
  timestamp: number;
  uuid: string;
}

/**
 * Parse every transcript file belonging to one session (main + subagents) and
 * return the index entry.
 */
function parseSessionFiles(
  files: string[],
  sessionId: string,
  fallbackCwd: string,
  customModels: CustomModelConfig[],
): SessionIndexEntry | null {
  let startedAt = 0;
  let lastUpdatedAt = 0;
  let cwd = '';
  let title = '';
  let slug = '';
  let firstUserText = '';

  const snapshots = new Map<string, AssistantSnapshot>();

  for (const file of files) {
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const lines = raw.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }

      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
      if (Number.isFinite(ts) && ts > 0) {
        if (!startedAt || ts < startedAt) startedAt = ts;
        if (ts > lastUpdatedAt) lastUpdatedAt = ts;
      }
      if (!cwd && typeof obj.cwd === 'string' && obj.cwd.trim()) cwd = obj.cwd;
      if (!slug && typeof obj.slug === 'string' && obj.slug.trim()) slug = obj.slug;

      if (!title && obj.type === 'ai-title') {
        const t = obj.aiTitle || obj.title;
        if (typeof t === 'string' && t.trim()) title = t.trim();
      }

      if (!firstUserText && obj.type === 'user' && obj.message?.role === 'user') {
        const text = extractUserText(obj.message.content);
        if (text) firstUserText = text;
      }

      if (obj.type !== 'assistant' || obj.message?.role !== 'assistant' || !obj.message?.usage) {
        continue;
      }

      const key = obj.message.id || obj.uuid;
      if (!key) continue;
      const candidate: AssistantSnapshot = {
        usage: normalizeUsage(obj.message.usage),
        model: normalizeModelNameFull(obj.message.model || 'unknown'),
        timestamp: Number.isFinite(ts) ? ts : 0,
        uuid: obj.uuid || key,
      };

      const existing = snapshots.get(key);
      if (!existing) {
        snapshots.set(key, candidate);
      } else if (isBetterSnapshot(candidate.usage, existing.usage)) {
        snapshots.set(key, candidate);
      }
    }
  }

  if (snapshots.size === 0 && !title && !firstUserText) return null;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheHitTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCostCNY = 0;
  let messageCount = 0;
  const modelCounts = new Map<string, number>();

  for (const snapshot of snapshots.values()) {
    const u = snapshot.usage;
    messageCount++;
    totalInputTokens += u.inputTokens;
    totalOutputTokens += u.outputTokens;
    totalCacheHitTokens += u.cacheReadTokens;
    totalCacheCreationTokens += u.cacheCreationTokens;
    modelCounts.set(snapshot.model, (modelCounts.get(snapshot.model) || 0) + 1);

    const detail = calculateCostDetail(
      snapshot.model,
      u,
      snapshot.timestamp || Date.now(),
      customModels,
    );
    if (detail.known) {
      totalCostCNY += convertCurrency(detail.amount, detail.currency, 'CNY');
    }
  }

  let primaryModel = 'unknown';
  let maxCount = 0;
  for (const [model, count] of modelCounts) {
    if (count > maxCount) { maxCount = count; primaryModel = model; }
  }

  const fingerprint = fingerprintFiles(files);
  const displayTitle = title || firstUserText || slug || sessionId.slice(0, 8) + '...';

  return {
    sessionId,
    title: displayTitle.slice(0, 80),
    cwd: cwd || fallbackCwd,
    startedAt: startedAt || lastUpdatedAt,
    lastUpdatedAt,
    messageCount,
    totalInputTokens,
    totalOutputTokens,
    totalCacheHitTokens,
    totalCacheMissTokens: 0, // cache-miss input is already totalInputTokens (schema compat)
    totalCacheCreationTokens,
    totalCostCNY: Number.isFinite(totalCostCNY) ? totalCostCNY : 0,
    primaryModel,
    slug: slug || undefined,
    fileSize: fingerprint.size,
    fileMtimeMs: fingerprint.mtimeMs,
  };
}

function extractUserText(content: any): string {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    // System-injected content is not a useful title
    if (!trimmed || trimmed.startsWith('<')) return '';
    return trimmed.slice(0, 40);
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string' && !item.tool_use_id) {
        const trimmed = item.text.trim();
        if (trimmed && !trimmed.startsWith('<')) return trimmed.slice(0, 40);
      }
    }
  }
  return '';
}