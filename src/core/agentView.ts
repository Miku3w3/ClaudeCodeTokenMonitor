/**
 * Helpers for the live/current-session view.
 *
 * The live accumulator appends main-transcript events first and subagent events
 * afterwards, so the in-memory list is not chronological. The panel only shows a
 * recent window, so it must be sorted by timestamp before slicing — otherwise
 * every main-agent message falls outside the window and the table looks like it
 * contains subagents only.
 *
 * The main/subagent split must be computed from the FULL list (not the recent
 * window): a 200-message window says nothing about the session totals.
 */
import type { PerMessageStats } from '../model/types';

export interface AgentUsage {
  cost: number;
  tokens: number;
  messages: number;
}

export interface AgentBreakdownEntry extends AgentUsage {
  id: string;
  label: string;
}

export interface AgentStats {
  main: AgentUsage;
  sub: AgentUsage;
  /** One entry per subagent, most expensive first. */
  agents: AgentBreakdownEntry[];
}

function safeNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function messageTokens(m: PerMessageStats): number {
  return safeNumber(m.inputTokens) + safeNumber(m.cacheReadTokens)
    + safeNumber(m.cacheCreationTokens) + safeNumber(m.outputTokens);
}

/** Stable chronological sort (equal timestamps keep their insertion order). */
export function sortChronologically(list: PerMessageStats[]): PerMessageStats[] {
  return list.slice().sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
}

/**
 * The most recent `limit` messages, oldest → newest.
 *
 * Under heavy subagent fan-out the newest window can consist of subagent
 * messages only. The latest main-agent response is then prepended so the table
 * never implies the main agent did nothing (the split bar uses agentStats, so
 * this is purely about what the table shows).
 */
export function recentMessages(list: PerMessageStats[], limit = 200): PerMessageStats[] {
  if (limit <= 0) return [];
  const sorted = sortChronologically(list);
  const windowed = sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
  const hasMainAssistant = windowed.some(m => !m.isUserMessage && m.source !== 'subagent');
  if (hasMainAssistant) return windowed;

  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    if (!m.isUserMessage && m.source !== 'subagent') {
      return [m, ...windowed];
    }
  }
  return windowed;
}

/**
 * Split assistant usage into main agent vs subagents.
 * `toDisplayCost` converts a CNY amount into the display currency.
 */
export function buildAgentStats(
  list: PerMessageStats[],
  toDisplayCost: (cny: number) => number = (cny) => cny,
): AgentStats {
  const main: AgentUsage = { cost: 0, tokens: 0, messages: 0 };
  const sub: AgentUsage = { cost: 0, tokens: 0, messages: 0 };
  const agents = new Map<string, AgentBreakdownEntry>();

  for (const m of list) {
    if (m.isUserMessage) continue;
    const rawCost = safeNumber(m.costCNY);
    const converted = Number.isFinite(toDisplayCost(rawCost)) ? toDisplayCost(rawCost) : rawCost;
    const tokens = messageTokens(m);

    if (m.source === 'subagent') {
      sub.cost += converted;
      sub.tokens += tokens;
      sub.messages += 1;

      const id = m.agentId || 'unknown';
      let entry = agents.get(id);
      if (!entry) {
        entry = { id, label: m.agentLabel || id.slice(0, 8), cost: 0, tokens: 0, messages: 0 };
        agents.set(id, entry);
      }
      entry.cost += converted;
      entry.tokens += tokens;
      entry.messages += 1;
    } else {
      main.cost += converted;
      main.tokens += tokens;
      main.messages += 1;
    }
  }

  return {
    main,
    sub,
    agents: Array.from(agents.values()).sort((a, b) => b.cost - a.cost),
  };
}