/**
 * Usage normalization helpers.
 *
 * Claude Code transcripts contain several `assistant` lines per API response:
 * the same `message.id` is emitted repeatedly while the response streams, with
 * progressively complete `usage` objects. Placeholder lines have
 * `output_tokens: 0` and usually omit the cache fields entirely. Treating every
 * line as a separate message (or adding `undefined` into a counter) corrupts
 * both tokens and cost, so every consumer must go through these helpers.
 */

export interface NormalizedUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

/** Coerce anything to a finite, non-negative number (0 otherwise). */
export function finiteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Normalize a raw `message.usage` object from a transcript line. */
export function normalizeUsage(raw: any): NormalizedUsage {
  return {
    inputTokens: finiteNumber(raw?.input_tokens),
    cacheReadTokens: finiteNumber(raw?.cache_read_input_tokens),
    cacheCreationTokens: finiteNumber(raw?.cache_creation_input_tokens),
    outputTokens: finiteNumber(raw?.output_tokens),
  };
}

/** Sum of all token counters, useful for display and comparisons. */
export function usageTotal(u: NormalizedUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens + u.outputTokens;
}

/**
 * True when `candidate` is a better (more complete) snapshot than `current`.
 *
 * The final billed usage is the snapshot with the highest `output_tokens`;
 * trailing zero-output placeholder lines must never replace a real snapshot.
 * On a tie prefer the snapshot carrying cache information, so a complete line
 * wins over an earlier placeholder with identical output.
 */
export function isBetterSnapshot(candidate: NormalizedUsage, current: NormalizedUsage): boolean {
  if (candidate.outputTokens !== current.outputTokens) {
    return candidate.outputTokens > current.outputTokens;
  }
  const candidateCache = candidate.cacheReadTokens + candidate.cacheCreationTokens;
  const currentCache = current.cacheReadTokens + current.cacheCreationTokens;
  if (candidateCache !== currentCache) return candidateCache > currentCache;
  return false;
}

/**
 * Group transcript records by `message.id` (falling back to `uuid`), keeping the
 * best snapshot for each message and the position of the chosen line.
 */
export function groupUsageSnapshots<T extends { messageId?: string; uuid: string; usage: NormalizedUsage }>(
  records: T[]
): Array<T & { messageId: string; usage: NormalizedUsage }> {
  const chosen = new Map<string, number>();
  const result: Array<T & { messageId: string; usage: NormalizedUsage }> = [];

  for (const record of records) {
    const key = record.messageId || record.uuid;
    const existingIndex = chosen.get(key);
    if (existingIndex === undefined) {
      chosen.set(key, result.length);
      result.push({ ...record, messageId: key });
      continue;
    }
    const existing = result[existingIndex];
    if (isBetterSnapshot(record.usage, existing.usage)) {
      result[existingIndex] = { ...record, messageId: key };
    }
  }
  return result;
}