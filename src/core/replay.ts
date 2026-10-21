/**
 * Transcript replay: turn JSONL lines into per-message statistics.
 *
 * Streaming snapshots of one assistant response share `message.id` but have
 * different `uuid`s. We keep the snapshot with the largest output_tokens and
 * emit it once, at the position of that line, so turn timing stays sensible.
 */
import { parseLine } from '../parsers/TranscriptParser';
import { normalizeUsage, isBetterSnapshot, type NormalizedUsage } from './usage';
import { normalizeModelName, calculateCostDetail, convertCurrency } from '../model/pricing';
import type { PerMessageStats, CustomModelConfig } from '../model/types';

interface ReplayEvent {
  event: NonNullable<ReturnType<typeof parseLine>>;
  order: number;
}

/** Where the lines came from: the main transcript or one subagent transcript. */
export interface TranscriptSource {
  kind: 'main' | 'subagent';
  agentId?: string;
  agentLabel?: string;
}

/** Parse JSONL lines into PerMessageStats[]. */
export function replayTranscriptLines(
  lines: string[],
  customModels: CustomModelConfig[] = [],
  source: TranscriptSource = { kind: 'main' },
): PerMessageStats[] {
  const events: ReplayEvent[] = [];
  let order = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = parseLine(line);
    if (!event) continue;
    events.push({ event, order: order++ });
  }

  const bestSnapshots = new Map<string, { usage: NormalizedUsage; order: number }>();
  for (const { event, order: lineOrder } of events) {
    if (event.type !== 'assistant' || !event.usage) continue;
    const key = event.messageId || event.uuid;
    if (!key) continue;
    const usage = normalizeUsage(event.usage);
    const previous = bestSnapshots.get(key);
    if (!previous || isBetterSnapshot(usage, previous.usage)) {
      bestSnapshots.set(key, { usage, order: lineOrder });
    }
  }

  const result: PerMessageStats[] = [];
  const emitted = new Set<string>();
  let pendingTs: number | null = null;
  let turnAccumMs = 0;

  for (const { event, order: lineOrder } of events) {
    if (event.type === 'user') {
      result.push({
        uuid: event.uuid, timestamp: event.timestamp, isUserMessage: true,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        model: '', costCNY: 0, costKnown: true, thinkingTimeMs: null,
        source: source.kind, agentId: source.agentId, agentLabel: source.agentLabel,
      });
      pendingTs = new Date(event.timestamp).getTime();
      turnAccumMs = 0;
      continue;
    }

    if (event.type === 'tool_result') {
      pendingTs = new Date(event.timestamp).getTime();
      continue;
    }

    if (event.type !== 'assistant' || !event.usage) continue;
    const key = event.messageId || event.uuid;
    if (!key || emitted.has(key)) continue;
    const best = bestSnapshots.get(key);
    if (!best || best.order !== lineOrder) continue;
    emitted.add(key);

    const usage = best.usage;
    const model = normalizeModelName(event.model || 'unknown');
    const tsMs = new Date(event.timestamp).getTime();
    const detail = calculateCostDetail(
      model,
      usage,
      Number.isFinite(tsMs) ? tsMs : Date.now(),
      customModels,
    );
    const costCNY = detail.known ? convertCurrency(detail.amount, detail.currency, 'CNY') : 0;

    let thinkTime: number | null = null;
    if (pendingTs !== null) {
      thinkTime = tsMs - pendingTs;
      turnAccumMs += thinkTime;
      pendingTs = tsMs;
    }

    result.push({
      uuid: event.uuid, messageId: key, timestamp: event.timestamp, isUserMessage: false,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens,
      model, costCNY, costNative: detail.amount, costCurrency: detail.currency,
      costKnown: detail.known, thinkingTimeMs: thinkTime,
      turnAiTimeMs: turnAccumMs,
      source: source.kind, agentId: source.agentId, agentLabel: source.agentLabel,
    });
  }

  return result;
}