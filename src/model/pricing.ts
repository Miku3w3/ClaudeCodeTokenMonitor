/**
 * Multi-provider pricing for Claude Code Token Monitor.
 *
 * Supports Aliyun Bailian (DeepSeek/Qwen, CNY), Anthropic (USD), OpenAI (USD),
 * plus user custom models and a catalog loaded from the bundled pricing.json.
 * All prices are stored in the provider's native currency and converted on
 * display.
 *
 * Resolution never guesses. An unknown model resolves to `null` and is shown
 * with an explicit "unknown pricing" marker; it is never charged at the price
 * of the provider's most expensive model.
 */
import type {
  ModelPricing,
  ResolvedPricing,
  ProviderMeta,
  PricingCatalog,
  Currency,
  CustomModelConfig,
} from './types';

// ═══════════════════════════════════════════════════════════════
// Built-in pricing table (native currency, per 1M tokens)
// ═══════════════════════════════════════════════════════════════

const PROVIDERS: ProviderMeta[] = [
  // ── Aliyun Bailian ────────────────────────────────────────
  {
    id: 'aliyun-bailian',
    name: 'Aliyun Bailian',
    nativeCurrency: 'CNY',
    models: {
      'deepseek-v4.1-flash': {
        cacheHit: 0.04, cacheMiss: 2.0, output: 8.0,
        offPeak: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 },
        verified: 'bailian-2026-10-21', notes: 'cacheHit from secondary source (unverified); cache writes billed as cache miss',
      },
      'deepseek-v4-pro': {
        cacheHit: 0, cacheMiss: 12.0, output: 24.0,
        verified: 'bailian-2026-10-21',
      },
      'deepseek-v4-pro-0813': {
        cacheHit: 0, cacheMiss: 9.0, output: 27.0,
        offPeak: { cacheHit: 0, cacheMiss: 4.5, output: 13.5 },
        verified: 'bailian-2026-10-21',
      },
      'deepseek-v4-flash-0731': {
        cacheHit: 0, cacheMiss: 3.0, output: 9.0,
        offPeak: { cacheHit: 0, cacheMiss: 1.5, output: 4.5 },
        verified: 'bailian-2026-10-21',
      },
      'qwen3.5-plus':       { cacheHit: 0, cacheMiss: 0.80, output: 4.80 },
      'qwen3.5-flash':      { cacheHit: 0, cacheMiss: 0.20, output: 2.00 },
      'qwen-long':          { cacheHit: 0, cacheMiss: 0.50, output: 2.00 },
    },
    aliases: {
      'deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash',
      'deepseek-v4.1-flash-1017-1m': 'deepseek-v4.1-flash',
    },
    matchPattern: /deepseek|qwen|bailian|dashscope/i,
  },
  // ── Anthropic ─────────────────────────────────────────────
  {
    id: 'anthropic',
    name: 'Anthropic',
    nativeCurrency: 'USD',
    models: {
      'claude-fable-5-1':   { cacheHit: 1.00, cacheMiss: 10.00, output: 50.00, cacheWrite: 12.50 },
      'claude-fable-5':     { cacheHit: 1.00, cacheMiss: 10.00, output: 50.00, cacheWrite: 12.50 },
      'claude-opus-5-5':    { cacheHit: 0.40, cacheMiss: 4.00,  output: 20.00, cacheWrite: 5.00 },
      'claude-opus-5':      { cacheHit: 0.50, cacheMiss: 5.00,  output: 25.00, cacheWrite: 6.25 },
      'claude-sonnet-5-5':  { cacheHit: 0.20, cacheMiss: 2.00,  output: 10.00, cacheWrite: 2.50 },
      'claude-sonnet-5':    { cacheHit: 0.20, cacheMiss: 2.00,  output: 10.00, cacheWrite: 2.50 },
      'claude-haiku-5-5':   { cacheHit: 0.01, cacheMiss: 0.10,  output: 0.50,  cacheWrite: 0.125 },
      'claude-opus-4-8':    { cacheHit: 1.50, cacheMiss: 15.00, output: 75.00, cacheWrite: 18.75 },
      'claude-sonnet-4-6':  { cacheHit: 0.60, cacheMiss: 6.00,  output: 30.00, cacheWrite: 7.50 },
      'claude-haiku-4-5':   { cacheHit: 0.15, cacheMiss: 1.50,  output: 7.50,  cacheWrite: 1.875 },
    },
    matchPattern: /claude|anthropic/i,
  },
  // ── OpenAI ────────────────────────────────────────────────
  {
    id: 'openai',
    name: 'OpenAI',
    nativeCurrency: 'USD',
    models: {
      'gpt-6.1-sol':        { cacheHit: 0.20, cacheMiss: 2.00,  output: 10.00, verified: 'openrouter-2026-10-21' },
      'gpt-6-sol':          { cacheHit: 0.20, cacheMiss: 2.00,  output: 10.00, verified: 'openrouter-2026-10-21' },
      'gpt-6-astra':        { cacheHit: 1.00, cacheMiss: 10.00, output: 50.00, verified: 'openrouter-2026-10-21' },
      'gpt-6-luna':         { cacheHit: 0.01, cacheMiss: 0.10,  output: 0.50,  verified: 'openrouter-2026-10-21' },
      'gpt-5.6-terra':      { cacheHit: 0.20, cacheMiss: 2.00,  output: 12.00, verified: 'openrouter-2026-10-21' },
      'gpt-5.6-sol':        { cacheHit: 0.40, cacheMiss: 4.00,  output: 20.00, verified: 'openrouter-2026-10-21' },
      'gpt-5.6-luna':       { cacheHit: 0.02, cacheMiss: 0.20,  output: 1.20,  verified: 'openrouter-2026-10-21' },
      'gpt-5.5':            { cacheHit: 0.50, cacheMiss: 5.00,  output: 30.00 },
      'gpt-5.5-pro':        { cacheHit: 3.00, cacheMiss: 30.00, output: 180.00 },
      'gpt-4o':             { cacheHit: 1.25, cacheMiss: 2.50,  output: 10.00 },
      'gpt-4o-mini':        { cacheHit: 0.075, cacheMiss: 0.15, output: 0.60 },
      'gpt-4.1':            { cacheHit: 1.25, cacheMiss: 2.50,  output: 10.00 },
    },
    matchPattern: /gpt|o1|o3|o4|openai/i,
  },
  // ── Google Gemini ─────────────────────────────────────────
  {
    id: 'google',
    name: 'Google',
    nativeCurrency: 'USD',
    models: {
      'gemini-2.5-pro':     { cacheHit: 0, cacheMiss: 1.25, output: 10.00 },
      'gemini-2.5-flash':   { cacheHit: 0, cacheMiss: 0.15, output: 0.60 },
    },
    matchPattern: /gemini/i,
  },
  // ── Moonshot Kimi ─────────────────────────────────────────
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    nativeCurrency: 'USD',
    models: {
      'kimi-k2.5':          { cacheHit: 0.10, cacheMiss: 0.60, output: 3.00 },
      'kimi-k2.6':          { cacheHit: 0.16, cacheMiss: 0.95, output: 4.00 },
    },
    matchPattern: /kimi|moonshot/i,
  },
  // ── Zhipu GLM (智谱) ─────────────────────────────────────
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    nativeCurrency: 'CNY',
    models: {
      'glm-4.7':            { cacheHit: 0, cacheMiss: 2.00, output: 16.00 },
      'glm-5':              { cacheHit: 0, cacheMiss: 4.00, output: 18.00 },
    },
    matchPattern: /glm|zhipu/i,
  },
  // ── ByteDance Doubao (字节豆包) ───────────────────────────
  {
    id: 'bytedance',
    name: 'ByteDance Doubao',
    nativeCurrency: 'CNY',
    models: {
      'doubao-seed-1.8':    { cacheHit: 0, cacheMiss: 0.80, output: 2.00 },
      'doubao-seed-2.0-pro': { cacheHit: 0, cacheMiss: 3.20, output: 16.00 },
    },
    matchPattern: /doubao/i,
  },
  // ── Baidu Ernie (百度文心) ────────────────────────────────
  {
    id: 'baidu',
    name: 'Baidu Ernie',
    nativeCurrency: 'CNY',
    models: {
      'ernie-4.5-turbo':    { cacheHit: 0.20, cacheMiss: 0.80, output: 3.20 },
      'ernie-5.1':          { cacheHit: 0, cacheMiss: 4.00, output: 18.00 },
    },
    matchPattern: /ernie/i,
  },
  // ── xAI Grok ──────────────────────────────────────────────
  {
    id: 'xai',
    name: 'xAI Grok',
    nativeCurrency: 'USD',
    models: {
      'grok-4':             { cacheHit: 0, cacheMiss: 2.00, output: 8.00 },
    },
    matchPattern: /grok/i,
  },
  // ── Mistral ───────────────────────────────────────────────
  {
    id: 'mistral',
    name: 'Mistral',
    nativeCurrency: 'USD',
    models: {
      'mistral-large':      { cacheHit: 0, cacheMiss: 2.00, output: 6.00 },
      'mistral-small':      { cacheHit: 0, cacheMiss: 0.20, output: 0.60 },
    },
    matchPattern: /mistral/i,
  },
];

export const BUILTIN_CATALOG: PricingCatalog = {
  schemaVersion: 2,
  updatedAt: '2026-10-21',
  source: 'builtin',
  providers: PROVIDERS,
  aliases: {},
};

// ═══════════════════════════════════════════════════════════════
// Exchange rates: 1 USD = X units of target currency
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_RATES: Record<string, number> = {
  USD: 1.0,
  CNY: 7.25,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 157.0,
  KRW: 1380.0,
};

// ═══════════════════════════════════════════════════════════════
// Currency auto-detect
// ═══════════════════════════════════════════════════════════════

export function resolveCurrency(currencySetting: string, language: string): Currency {
  if (currencySetting !== 'auto') return currencySetting as Currency;
  if (language.startsWith('zh')) return 'CNY';
  if (language.startsWith('ja')) return 'JPY';
  if (language.startsWith('ko')) return 'KRW';
  if (language === 'es' || language === 'de' || language === 'fr' || language === 'pt') return 'EUR';
  if (language === 'en') return 'USD';
  if (language === 'ar' || language === 'ru') return 'USD';
  return 'USD';
}

// ═══════════════════════════════════════════════════════════════
// Model name normalization
// ═══════════════════════════════════════════════════════════════

export function normalizeModelName(raw: string): string {
  return (raw || '')
    .replace(/\[.*?\]/g, '')   // Remove [1m] and similar suffixes
    .replace(/-free$/i, '')    // Normalize free-tier model names
    .trim();
}

function canonicalKey(raw: string): string {
  return normalizeModelName(raw)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/^-+|-+$/g, '');
}

function finite(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isCurrency(value: unknown): value is Currency {
  return value === 'CNY' || value === 'USD' || value === 'EUR'
    || value === 'JPY' || value === 'KRW' || value === 'GBP';
}

// ═══════════════════════════════════════════════════════════════
// Catalog sanitizing and indexing
// ═══════════════════════════════════════════════════════════════

function sanitizePricing(raw: any): ModelPricing | null {
  if (!raw || typeof raw !== 'object') return null;
  // Accept the legacy flat shape and the nested {input:{cacheHit,cacheMiss}}
  // shape used by the published pricing.json.
  const flat = raw.input && typeof raw.input === 'object'
    ? { cacheHit: raw.input.cacheHit, cacheMiss: raw.input.cacheMiss, output: raw.output, cacheWrite: raw.cacheWrite }
    : raw;

  const cacheHit = finite(flat.cacheHit);
  const cacheMiss = finite(flat.cacheMiss);
  const output = finite(flat.output);
  const cacheWriteRaw = flat.cacheWrite;
  const cacheWrite = cacheWriteRaw === undefined || cacheWriteRaw === null
    ? undefined
    : finite(cacheWriteRaw);

  if (cacheHit <= 0 && cacheMiss <= 0 && output <= 0) return null;

  let offPeak: ModelPricing['offPeak'];
  if (flat.offPeak && typeof flat.offPeak === 'object') {
    const opHit = finite(flat.offPeak.cacheHit);
    const opMiss = finite(flat.offPeak.cacheMiss);
    const opOut = finite(flat.offPeak.output);
    if (opHit > 0 || opMiss > 0 || opOut > 0) {
      offPeak = { cacheHit: opHit, cacheMiss: opMiss, output: opOut };
      if (flat.offPeak.cacheWrite !== undefined) offPeak.cacheWrite = finite(flat.offPeak.cacheWrite);
    }
  }

  const pricing: ModelPricing = { cacheHit, cacheMiss, output };
  if (cacheWrite !== undefined) pricing.cacheWrite = cacheWrite;
  if (offPeak) pricing.offPeak = offPeak;
  if (typeof flat.verified === 'string') pricing.verified = flat.verified;
  if (typeof flat.notes === 'string') pricing.notes = flat.notes;
  return pricing;
}

function sanitizeAliases(raw: any): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const aliases: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue;
    const from = canonicalKey(key);
    const to = canonicalKey(value);
    if (!from || !to || from === 'error' || to === 'error') continue;
    aliases[from] = to;
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

function sanitizeCatalog(input: any): PricingCatalog | null {
  if (!input || !Array.isArray(input.providers)) return null;

  const providers: ProviderMeta[] = [];
  for (const rawProvider of input.providers) {
    if (!rawProvider || typeof rawProvider !== 'object') continue;
    const rawModels = rawProvider.models;
    if (!rawModels || typeof rawModels !== 'object') continue;

    const models: Record<string, ModelPricing> = {};
    for (const [rawKey, rawPricing] of Object.entries(rawModels)) {
      const key = canonicalKey(rawKey);
      if (!key || key === 'error') continue;
      const pricing = sanitizePricing(rawPricing);
      if (pricing) models[key] = pricing;
    }
    if (Object.keys(models).length === 0) continue;

    const name = typeof rawProvider.name === 'string' && rawProvider.name.trim()
      ? rawProvider.name.trim()
      : 'Unknown';
    const nativeCurrency = isCurrency(rawProvider.nativeCurrency)
      ? rawProvider.nativeCurrency
      : isCurrency(rawProvider.currency)
        ? rawProvider.currency
        : 'USD';
    let matchPattern: RegExp;
    try {
      matchPattern = rawProvider.matchPattern instanceof RegExp
        ? rawProvider.matchPattern
        : new RegExp(String(rawProvider.matchPattern || rawProvider.id || name), 'i');
    } catch {
      matchPattern = /$^/;
    }

    const provider: ProviderMeta = {
      name,
      nativeCurrency,
      models,
      matchPattern,
    };
    if (typeof rawProvider.id === 'string' && rawProvider.id) provider.id = rawProvider.id;
    const aliases = sanitizeAliases(rawProvider.aliases);
    if (aliases) provider.aliases = aliases;
    providers.push(provider);
  }

  if (providers.length === 0) return null;
  return {
    schemaVersion: finite(input.schemaVersion) || 2,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : undefined,
    source: typeof input.source === 'string' ? input.source : undefined,
    providers,
    aliases: sanitizeAliases(input.aliases),
  };
}

interface IndexedModel {
  provider: ProviderMeta;
  key: string;
  pricing: ModelPricing;
}

let activeCatalog: PricingCatalog = BUILTIN_CATALOG;
let modelIndex = new Map<string, IndexedModel>();
let aliasIndex = new Map<string, string>();
let prefixKeys: string[] = [];

function rebuildIndex(): void {
  modelIndex = new Map<string, IndexedModel>();
  aliasIndex = new Map<string, string>();
  prefixKeys = [];

  for (const provider of activeCatalog.providers) {
    for (const [key, pricing] of Object.entries(provider.models)) {
      if (!modelIndex.has(key)) {
        modelIndex.set(key, { provider, key, pricing });
      }
    }
  }

  const addAlias = (from: string, to: string) => {
    const key = canonicalKey(from);
    let target = canonicalKey(to);
    if (!key || !target) return;
    if (!modelIndex.has(target)) target = canonicalKey(target.split('/').pop() || '');
    if (modelIndex.has(target)) aliasIndex.set(key, target);
  };

  for (const [from, to] of Object.entries(activeCatalog.aliases || {})) addAlias(from, to);
  for (const provider of activeCatalog.providers) {
    for (const [from, to] of Object.entries(provider.aliases || {})) addAlias(from, to);
  }

  prefixKeys = Array.from(modelIndex.keys())
    .filter((key) => key.length >= 3)
    .sort((a, b) => b.length - a.length);
}

/** Replace the active catalog (bundled pricing.json or a validated remote update). */
export function setPricingCatalog(catalog: PricingCatalog): boolean {
  const sanitized = sanitizeCatalog(catalog);
  if (!sanitized) {
    console.warn('[TokenMonitor] Pricing catalog rejected: no usable providers');
    return false;
  }
  activeCatalog = sanitized;
  rebuildIndex();
  return true;
}

export function getPricingCatalog(): PricingCatalog {
  return activeCatalog;
}

export function getPricingUpdatedAt(): string | undefined {
  return activeCatalog.updatedAt;
}

// Legacy API kept for compatibility with pricing-fetcher / older callers.
export function setCustomProviders(providers: ProviderMeta[] | null): void {
  if (!providers || providers.length === 0) {
    setPricingCatalog(BUILTIN_CATALOG);
    return;
  }
  if (!setPricingCatalog({ schemaVersion: 2, providers })) {
    console.warn('[TokenMonitor] Remote providers rejected');
  }
}

export function getCustomProviders(): ProviderMeta[] | null {
  return activeCatalog.providers;
}

// Build the index for the built-in table on module load.
rebuildIndex();

// ═══════════════════════════════════════════════════════════════
// Pricing resolution
// ═══════════════════════════════════════════════════════════════

export function autoDetectProvider(modelName: string): ProviderMeta | null {
  const normalized = normalizeModelName(modelName);
  for (const provider of activeCatalog.providers) {
    try {
      if (provider.matchPattern.test(normalized)) return provider;
    } catch { /* invalid regex — skip */ }
  }
  return null;
}

function toResolved(hit: IndexedModel, override?: ModelPricing): ResolvedPricing {
  const pricing = override || hit.pricing;
  const resolved: ResolvedPricing = {
    ...pricing,
    currency: hit.provider.nativeCurrency,
    providerName: hit.provider.name,
    matchedModel: hit.key,
  };
  if (hit.provider.id) resolved.providerId = hit.provider.id;
  return resolved;
}

function isBoundary(char: string): boolean {
  return char === '' || char === '-' || char === '_' || char === '.'
    || char === ':' || char === '@' || char === '/';
}

/**
 * Resolve pricing for a model. Returns null when the model is unknown — callers
 * must display "unknown pricing" instead of inventing a number.
 *
 * Order: custom models → exact alias → exact key → snapshot suffix → longest
 * prefix (provider tables are not used to guess a price).
 */
export function resolvePricing(
  modelName: string,
  customModels: CustomModelConfig[] = [],
): ResolvedPricing | null {
  const normalized = normalizeModelName(modelName);
  const lower = normalized.toLowerCase();

  // 1. User custom models (first match wins)
  for (const cm of customModels) {
    if (!cm.matchPattern) continue;
    try {
      const re = new RegExp(cm.matchPattern, 'i');
      if (!re.test(normalized)) continue;
      const resolved: ResolvedPricing = {
        cacheHit: finite(cm.cacheHit),
        cacheMiss: finite(cm.cacheMiss),
        output: finite(cm.output),
        currency: isCurrency(cm.currency) ? cm.currency : 'USD',
        providerName: cm.name || 'Custom',
        matchedModel: cm.name || cm.matchPattern,
      };
      return resolved;
    } catch { /* invalid regex — skip */ }
  }

  if (!lower) return null;

  // 2. Exact alias
  const aliasTarget = aliasIndex.get(lower) || aliasIndex.get(canonicalKey(lower));
  if (aliasTarget) {
    const hit = modelIndex.get(aliasTarget);
    if (hit) return toResolved(hit);
  }

  // 3. Exact key (also try underscore ↔ dash canonical form)
  const exact = modelIndex.get(lower) || modelIndex.get(canonicalKey(lower));
  if (exact) return toResolved(exact);

  // 4. Strip a dated snapshot suffix, e.g. "-20250514" or "-1017"
  const stripped = lower.replace(/[-_/]?\d{4,8}$/, '');
  if (stripped !== lower) {
    const hit = modelIndex.get(stripped) || modelIndex.get(canonicalKey(stripped));
    if (hit) return toResolved(hit);
  }

  // 5. Longest prefix on a boundary — handles "model-2026-01-01" style names
  for (const key of prefixKeys) {
    if (lower.startsWith(key) && isBoundary(lower.charAt(key.length))) {
      const hit = modelIndex.get(key);
      if (hit) return toResolved(hit);
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Exchange rates
// ═══════════════════════════════════════════════════════════════

let customRates: Record<string, number> = {};
let ratesUpdatedAt = 0;
export function setCustomRates(rates: Record<string, number>, updatedAt?: number): void {
  const sanitized: Record<string, number> = {};
  if (rates) {
    for (const [k, v] of Object.entries(rates)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) sanitized[k.toUpperCase()] = n;
    }
  }
  customRates = sanitized;
  if (updatedAt) ratesUpdatedAt = updatedAt;
}
export function getRatesUpdatedAt(): number { return ratesUpdatedAt; }

function getRate(code: string): number {
  const upper = (code || '').toUpperCase();
  const fromCustom = customRates[upper];
  if (fromCustom !== undefined && Number.isFinite(fromCustom) && fromCustom > 0) return fromCustom;
  const fromDefault = DEFAULT_RATES[upper];
  if (fromDefault !== undefined && Number.isFinite(fromDefault) && fromDefault > 0) return fromDefault;
  return 1.0;
}

/**
 * Convert an amount from one currency to another.
 * Same currency → no conversion (zero precision loss).
 */
export function convertCurrency(amount: number, from: Currency, to: Currency): number {
  if (!Number.isFinite(amount)) return 0;
  if (from === to) return amount;
  const usd = amount / getRate(from);
  return usd * getRate(to);
}

// ═══════════════════════════════════════════════════════════════
// Cost calculation
// ═══════════════════════════════════════════════════════════════

export interface CostDetail {
  /** Cost in the provider's native currency */
  amount: number;
  currency: Currency;
  /** False when no pricing entry matched the model */
  known: boolean;
  providerName: string;
  matchedModel: string;
}

export interface UsageTokens {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens?: number;
  outputTokens: number;
}

/**
 * Aliyun Bailian peak hours (Beijing time): workdays 09:00–12:00 and
 * 14:00–18:00. Everything else is off-peak. Unknown timestamps are treated as
 * peak (the conservative, higher price).
 */
export function isBailianOffPeak(timestampMs: number): boolean {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return false;
  const beijing = new Date(timestampMs + 8 * 3600_000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return true;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const peak = (minutes >= 9 * 60 && minutes < 12 * 60)
    || (minutes >= 14 * 60 && minutes < 18 * 60);
  return !peak;
}

/**
 * Calculate the cost of one assistant response. Unknown models return
 * `{ known: false, amount: 0 }` — never a guessed price.
 */
export function calculateCostDetail(
  model: string,
  usage: UsageTokens,
  timestampMs: number = Date.now(),
  customModels: CustomModelConfig[] = [],
): CostDetail {
  const pricing = resolvePricing(model, customModels);
  if (!pricing) {
    return {
      amount: 0,
      currency: 'CNY',
      known: false,
      providerName: 'Unknown',
      matchedModel: '',
    };
  }

  let effective: ModelPricing = pricing;
  if (pricing.providerId === 'aliyun-bailian' && pricing.offPeak && isBailianOffPeak(timestampMs)) {
    effective = { ...pricing, ...pricing.offPeak };
  }

  const input = finite(usage.inputTokens);
  const cacheRead = finite(usage.cacheReadTokens);
  const cacheCreation = finite(usage.cacheCreationTokens);
  const output = finite(usage.outputTokens);

  const cacheMissPrice = finite(effective.cacheMiss);
  const cacheHitPrice = finite(effective.cacheHit);
  const cacheWritePrice = effective.cacheWrite === undefined
    ? cacheMissPrice
    : finite(effective.cacheWrite);
  const outputPrice = finite(effective.output);

  const amount = (
    (input / 1_000_000) * cacheMissPrice
    + (cacheRead / 1_000_000) * cacheHitPrice
    + (cacheCreation / 1_000_000) * cacheWritePrice
    + (output / 1_000_000) * outputPrice
  );

  return {
    amount: Number.isFinite(amount) ? amount : 0,
    currency: pricing.currency,
    known: true,
    providerName: pricing.providerName,
    matchedModel: pricing.matchedModel,
  };
}

/** Cost in the provider's native currency (0 when the model is unknown). */
export function calculateCost(
  model: string,
  inputTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
  cacheCreationTokens: number = 0,
  customModels: CustomModelConfig[] = [],
  timestampMs: number = Date.now(),
): number {
  return calculateCostDetail(
    model,
    { inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens },
    timestampMs,
    customModels,
  ).amount;
}

// ═══════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥', USD: '$', EUR: '€', JPY: '¥', KRW: '₩', GBP: '£',
};

export function formatCost(cost: number, currency: string = 'CNY'): string {
  const symbol = CURRENCY_SYMBOLS[currency] || currency;
  if (!Number.isFinite(cost)) return '—';
  if (cost >= 100)  return `${symbol}${cost.toFixed(2)}`;
  if (cost >= 1)    return `${symbol}${cost.toFixed(3)}`;
  if (cost >= 0.01) return `${symbol}${cost.toFixed(4)}`;
  return `${symbol}${cost.toFixed(5)}`;
}

export function abbreviateTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) {
    const k = count / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  const m = count / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}