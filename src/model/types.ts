/**
 * Type definitions for the Claude Code Token Monitor extension v1.0.0.
 */

// ═══════════════════════════════════════════════════════════════
// Configuration types
// ═══════════════════════════════════════════════════════════════

export type Currency = 'CNY' | 'USD' | 'EUR' | 'JPY' | 'KRW' | 'GBP';

export interface CustomModelConfig {
  name: string;
  matchPattern: string;
  cacheHit: number;
  cacheMiss: number;
  output: number;
  currency?: string;
}

export interface ExtensionConfig {
  language: string;
  resolvedLanguage: string;
  currency: string;
  resolvedCurrency: Currency;
  exchangeRates: Record<string, number>;
  customModels: CustomModelConfig[];
  showModelName: boolean;
  compactMode: boolean;
  budgetWarning: number;
  pollIntervalMs: number;
  pricingUpdateUrl: string;
  /** Apply Aliyun Bailian peak/off-peak (time-of-day) pricing. */
  bailianPeakPricing: boolean;
}

/** Raw usage data from an assistant message in the JSONL transcript */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
  service_tier?: string;
  cache_creation?: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
  inference_geo?: string;
  iterations?: any[];
  speed?: string;
}

/** Parsed single line from JSONL transcript */
export interface ParsedEvent {
  type: 'user' | 'assistant' | 'ai-title' | 'tool_result' | 'other';
  timestamp: string;
  uuid: string;
  sessionId: string;
  /** True if this is a real user message (not a tool_result) */
  isRealUserMessage: boolean;
  /** For assistant events: the API message id (shared by all streaming snapshots) */
  messageId?: string;
  /** For all events: working directory recorded on the line (preferred over decoding the folder name) */
  cwd?: string;
  /** For all events: session slug, used as a title fallback */
  slug?: string;
  /** For subagent transcript lines: the agent that produced this line */
  agentId?: string;
  /** For subagent transcript lines: Claude Code marks them as sidechains */
  isSidechain?: boolean;
  /** For assistant events: the token usage */
  usage?: TokenUsage;
  /** For assistant events: the model name */
  model?: string;
  /** For ai-title events: the conversation title */
  title?: string;
}

/** Per-message statistics (computed from ParsedEvent) */
export interface PerMessageStats {
  uuid: string;
  /** API message id; all streaming snapshots of one response share it */
  messageId?: string;
  timestamp: string;
  isUserMessage: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
  /** Cost in CNY (converted at calculation time) */
  costCNY: number;
  /** Cost in the provider's native currency */
  costNative?: number;
  /** Native currency of the provider */
  costCurrency?: string;
  /** True when a pricing entry was found for the model */
  costKnown?: boolean;
  /** Cost converted to the user's display currency (filled in before sending to the webview) */
  costDisplay?: number;
  /** Wall-clock delta (ms) from preceding event to this assistant response */
  thinkingTimeMs: number | null;
  /** Accumulated AI working time (ms) within the current turn up to this message */
  turnAiTimeMs?: number;
  /** Where this message came from: the main transcript or a subagent transcript */
  source?: 'main' | 'subagent';
  /** Subagent id parsed from agent-<id>.jsonl (undefined for main-agent rows) */
  agentId?: string;
  /** Short label shown in the webview (currently the first 8 chars of agentId) */
  agentLabel?: string;
}

/** Aggregated session state held in TokenStore */
export interface SessionState {
  sessionId: string;
  cwd: string;
  startedAt: number;
  pid: number;
  title: string;
  model: string;
  messages: PerMessageStats[];
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCacheReadTokens: number;
  cumulativeCacheCreationTokens: number;
  cumulativeCostCNY: number;
  totalTokens: number;
  messageCount: number;
  lastLineCount: number;
  isActive: boolean;
  transcriptPath: string;
  lastUpdatedAt: string;
}

/** Content of session PID file: ~/.claude/sessions/{PID}.json */
export interface SessionPidFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  procStart?: string;
  version?: string;
  peerProtocol?: number;
  kind?: string;
  entrypoint?: string;
}

/** Content of IDE lock file: ~/.claude/ide/{PID}.lock */
export interface IDELockFile {
  pid: number;
  workspaceFolders?: string[];
  ideName?: string;
  transport?: string;
  runningInWindows?: boolean;
  authToken?: string;
}

/** Content written to current-session.json for Claude to read */
export interface ClaudeReadableData {
  sessionId: string;
  title: string;
  model: string;
  active: boolean;
  cumulative: {
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    messageCount: number;
    totalCostCNY: number;
    totalTokens: number;
  };
  lastMessage: {
    uuid: string;
    timestamp: string;
    type: string;
    model: string;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    costCNY: number;
    thinkingTimeMs: number | null;
  } | null;
  lastUserMessage: {
    uuid: string;
    timestamp: string;
    thinkingTimeMs: number | null;
  } | null;
  updatedAt: string;
}

/** Pricing per 1M tokens in a given currency */
export interface ModelPricing {
  cacheHit: number;
  cacheMiss: number;
  output: number;
  /** Cache-write price per 1M tokens (falls back to cacheMiss when absent) */
  cacheWrite?: number;
  /** Off-peak tier, when the provider offers one (e.g. Aliyun Bailian) */
  offPeak?: { cacheHit: number; cacheMiss: number; output: number; cacheWrite?: number };
  /** Where the numbers came from, e.g. "bailian-2026-10-21" */
  verified?: string;
  notes?: string;
}

/** Pricing resolved for the current model, including currency info */
export interface ResolvedPricing extends ModelPricing {
  currency: Currency;
  providerName: string;
  /** Stable provider id (e.g. "aliyun-bailian") */
  providerId?: string;
  /** Canonical model key that matched */
  matchedModel: string;
}

/** Pricing provider metadata */
export interface ProviderMeta {
  id?: string;
  name: string;
  nativeCurrency: Currency;
  models: Record<string, ModelPricing>;
  matchPattern: RegExp;
  /** Exact alias → canonical model key (e.g. dated snapshot names) */
  aliases?: Record<string, string>;
}

/** Pricing catalog loaded from bundled pricing.json or a remote update */
export interface PricingCatalog {
  schemaVersion: number;
  updatedAt?: string;
  source?: string;
  providers: ProviderMeta[];
  /** Global aliases applied before prefix matching */
  aliases?: Record<string, string>;
  /**
   * Chinese statutory holidays (YYYY-MM-DD, Beijing time). Days listed here are
   * billed at the off-peak price even when they fall on a weekday. Kept in the
   * remote catalog so a new year's schedule can ship without an extension
   * release.
   */
  holidays?: string[];
}

// ═══════════════════════════════════════════════════════════════
// Session index & aggregation types (v0.12.0)
// ═══════════════════════════════════════════════════════════════

/** Time range for filtering/aggregating sessions */
export type TimeRange = 'current' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all';

/** A lightweight summary of one session, persisted in sessions.json */
export interface SessionIndexEntry {
  sessionId: string;
  title: string;
  cwd: string;
  startedAt: number;       // epoch ms — first message timestamp
  lastUpdatedAt: number;   // epoch ms — last message timestamp
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheHitTokens: number;
  totalCacheMissTokens: number;
  totalCacheCreationTokens?: number;
  totalCostCNY: number;
  primaryModel: string;    // most-used model in this session
  /** Slug from the transcript, used when no title is available */
  slug?: string;
  /** Size/mtime of the main transcript file when the index entry was built */
  fileSize?: number;
  fileMtimeMs?: number;
}

/** Full session index persisted to ~/.claude/token-tracker/sessions.json */
export interface SessionIndex {
  version: number;
  updatedAt: number;         // epoch ms — last write time
  sessions: Record<string, SessionIndexEntry>;  // keyed by sessionId
}

/** Aggregated stats for a time-range view, sent to the webview */
export interface AggregatedData {
  timeRange: TimeRange;
  sessions: SessionIndexEntry[];
  totalTokens: number;
  totalCost: number;         // in display currency
  totalCostCNY: number;
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  cacheMiss: number;
  hitRate: number;           // 0–100
  messageCount: number;
  sessionCount: number;
  /** Per-model breakdown across the time range */
  modelStats: ModelStatEntry[];
}

/** Per-model stats used in both live and aggregated views */
export interface ModelStatEntry {
  model: string;
  cost: number;
  tokens: number;
  inputTokens: number;
  cacheHits: number;
  cacheMiss: number;
  outputTokens: number;
}

/** Message from webview to extension requesting filtered data */
export interface WebviewFilterMessage {
  type: 'setTimeRange';
  timeRange: TimeRange;
}

export interface WebviewSelectSessionMessage {
  type: 'selectSession';
  sessionId: string;
}

export interface WebviewClearSessionMessage {
  type: 'clearSessionSelection';
}

export type WebviewRequest =
  | WebviewFilterMessage
  | WebviewSelectSessionMessage
  | WebviewClearSessionMessage;
