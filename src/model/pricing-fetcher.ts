/**
 * Pricing data loader / updater.
 *
 * Sources, in order:
 *   1. bundled pricing.json (always available, works offline)
 *   2. validated remote catalog (daily-updated), tried against reachable mirrors
 *   3. last good remote cache
 *   4. built-in table in pricing.ts
 *
 * The catalog is produced by a scheduled job on a private server and published
 * to Aliyun OSS, so the OSS URL comes first: it is reachable from mainland
 * China without a proxy. GitHub mirrors stay as a fallback for networks where
 * OSS is slow.
 */
import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import { tokenMonitorDir } from '../utils/paths';
import {
  setCustomRates,
  getRatesUpdatedAt,
  hasFetchedRates,
  DEFAULT_RATES,
  setPricingCatalog,
  getPricingUpdatedAt,
} from './pricing';
import type { PricingCatalog } from './types';
import * as vscode from 'vscode';

const RATE_API_URLS = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.frankfurter.dev/v1/latest?from=USD',
];

/**
 * Cap for the rate phase. The rate APIs are small JSON documents and answer in
 * ~1.5s; anything slower is a blocked route, and the catalog still needs the
 * rest of TOTAL_FETCH_BUDGET.
 */
const RATES_TIMEOUT = 6000;

const REPO = 'Miku3w3/ClaudeCodeTokenMonitor';
const RAW = `https://raw.githubusercontent.com/${REPO}/master/pricing.json`;

/** Catalog published by the server job through Aliyun OSS (no filing, no proxy). */
export const OSS_PRICING_URL = 'https://cctm-pricing.oss-cn-shenzhen.aliyuncs.com/pricing.json';

export const PROVIDER_URLS = [
  OSS_PRICING_URL,
  `https://fastly.jsdelivr.net/gh/${REPO}@master/pricing.json`,
  `https://gcore.jsdelivr.net/gh/${REPO}@master/pricing.json`,
  `https://ghproxy.net/${RAW}`,
  `https://gh-proxy.com/${RAW}`,
  RAW,
  `https://cdn.jsdelivr.net/gh/${REPO}@master/pricing.json`,
];

/**
 * Hosts that answer directly from mainland China. When a proxy is configured
 * they are still tried without it first, so a dead proxy cannot delay the
 * primary catalog by a full timeout.
 */
const DIRECT_FIRST_HOSTS = ['aliyuncs.com'];

function prefersDirect(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return DIRECT_FIRST_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

const CACHE_TTL = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 8000;
/** Hard ceiling for one refresh cycle, so seven dead mirrors cannot take minutes. */
const TOTAL_FETCH_BUDGET = 20_000;

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function cachePath(): string { return path.join(tokenMonitorDir(), 'pricing-cache.json'); }

/**
 * Normalise a rate-API payload into `{ USD: 1, CNY: 6.69, ... }` — units of
 * each currency per 1 USD, which is the shape `setCustomRates` expects.
 *
 * Accepted payloads:
 *   open.er-api.com      { result: 'success', rates: { USD: 1, CNY: 6.69 } }
 *   frankfurter.dev      { base: 'USD', rates: { CNY: 6.69 } }   (USD omitted)
 *   fawazahmed currency  { date: '...', usd: { cny: 6.69 } }     (lowercase)
 *
 * Returns null when the payload carries no recognisable rate table, so the
 * caller can move on to the next source instead of trusting junk.
 */
export function normalizeRates(payload: any): Record<string, number> | null {
  if (!payload || typeof payload !== 'object') return null;

  let raw: Record<string, unknown> | null = null;
  let usdIncluded = false;

  if (payload.result === 'success' && payload.rates && typeof payload.rates === 'object') {
    raw = payload.rates;
    usdIncluded = true;
  } else if (payload.base === 'USD' && payload.rates && typeof payload.rates === 'object') {
    raw = payload.rates;
  } else if (payload.usd && typeof payload.usd === 'object') {
    raw = payload.usd;
    usdIncluded = true;
  }
  if (!raw) return null;

  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k.toUpperCase()] = n;
  }
  if (!usdIncluded) out.USD = 1;

  // A table without any of the currencies we display is not a rate table.
  if (!out.CNY && !out.EUR && !out.JPY && !out.GBP && !out.KRW) return null;
  return out;
}

/**
 * Fetch exchange rates from a free API (no key required).
 *
 * Tries each source directly first — that is the route that works on most
 * networks, including ones where a Clash-style proxy is running but does not
 * cover these hosts. When a direct attempt is blocked and the editor has an
 * `http.proxy` configured, the same URL is retried through that proxy, so a
 * network that only reaches the outside world via the proxy still gets fresh
 * rates.
 *
 * Returns `{USD, CNY, ...}` (units per 1 USD) or null.
 */
export async function fetchRatesFromAPI(
  timeoutMs: number = FETCH_TIMEOUT,
  proxyUrl: string = '',
): Promise<Record<string, number> | null> {
  if (timeoutMs <= 0) return null;
  const canProxy = !!proxyUrl && proxyUrl.startsWith('http');
  let remaining = timeoutMs;

  for (const url of RATE_API_URLS) {
    if (remaining <= 0) break;
    const started = Date.now();
    const direct = await fetchDirect(url, Math.min(remaining, RATES_TIMEOUT));
    const normalizedDirect = normalizeRates(direct);
    if (normalizedDirect) return normalizedDirect;

    remaining -= Date.now() - started;
    if (canProxy && remaining > 0) {
      const viaProxy = await fetchWithProxy(url, proxyUrl, Math.min(remaining, RATES_TIMEOUT));
      const normalizedProxy = normalizeRates(viaProxy);
      if (normalizedProxy) return normalizedProxy;
      remaining -= Date.now() - started;
    }
  }
  return null;
}

export interface RemotePricing {
  schemaVersion?: number;
  version?: number;
  updatedAt?: string;
  rates?: Record<string, number>;
  providers?: any[];
  [key: string]: any;
}

// ── Proxy tunnels (for Clash mixed-mode proxies) ─────────────────

function socks5Connect(proxyHost: string, proxyPort: number, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(FETCH_TIMEOUT);
    socket.connect(proxyPort, proxyHost, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
      socket.once('data', (data: Buffer) => {
        if (data[0] !== 0x05 || data[1] !== 0x00) { socket.destroy(); return reject(new Error('auth')); }
        const hostBytes = Buffer.from(targetHost, 'utf-8');
        const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(targetPort, 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]), hostBytes, portBuf]));
        socket.once('data', (resp: Buffer) => {
          if (resp[0] !== 0x05 || resp[1] !== 0x00) { socket.destroy(); return reject(new Error('connect')); }
          socket.setTimeout(0); resolve(socket);
        });
      });
    });
    socket.on('error', reject);
  });
}

function httpConnect(proxyHost: string, proxyPort: number, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(FETCH_TIMEOUT);
    socket.connect(proxyPort, proxyHost, () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}\r\n\r\n`);
      socket.once('data', (data: Buffer) => {
        if (!data.toString().includes('200')) { socket.destroy(); return reject(new Error('CONNECT')); }
        socket.setTimeout(0); resolve(socket);
      });
    });
    socket.on('error', reject);
  });
}

function tlsRequest(socket: net.Socket, parsed: URL): Promise<any | null> {
  return new Promise((resolve) => {
    const tlsSocket = tls.connect({
      socket,
      host: parsed.hostname,
      servername: parsed.hostname,
      rejectUnauthorized: true,
    }, () => {
      tlsSocket.write(`GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.hostname}\r\nUser-Agent: CCTM/1.3.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
      let body = '';
      tlsSocket.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      tlsSocket.on('end', () => {
        const json = body.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        try { resolve(JSON.parse(json)); } catch { resolve(null); }
      });
      tlsSocket.on('error', () => resolve(null));
    });
    tlsSocket.on('error', () => resolve(null));
    setTimeout(() => { tlsSocket.destroy(); resolve(null); }, FETCH_TIMEOUT);
  });
}

async function fetchWithProxy(urlStr: string, proxyUrl: string, timeoutMs: number = FETCH_TIMEOUT): Promise<any | null> {
  if (timeoutMs <= 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return null;
  }
  // Plain HTTP custom sources (for example a LAN/Alibaba server on a
  // non-standard port) are fetched directly; the SOCKS5/CONNECT tunnel below
  // only speaks TLS.
  if (parsed.protocol === 'http:') return fetchDirect(urlStr, timeoutMs);

  const proxy = new URL(proxyUrl);
  const h = proxy.hostname, p = parseInt(proxy.port) || 7890;
  for (const fn of [() => socks5Connect(h, p, parsed.hostname, 443), () => httpConnect(h, p, parsed.hostname, 443)]) {
    try { const s = await fn(); const d = await tlsRequest(s, parsed); if (d) return d; } catch { /* next */ }
  }
  return null;
}

/**
 * Fetch and parse a JSON document without a proxy.
 *
 * Redirects are followed (up to 5 hops) because a mirror such as Gitee answers
 * with a 302 to its CDN; a plain 200-only check would treat that as a dead
 * source. Any transport error, non-200 status or unparseable body resolves to
 * null so the caller can move on to the next source.
 */
export function fetchDirect(urlStr: string, timeoutMs: number = FETCH_TIMEOUT, redirects = 0): Promise<any | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return Promise.resolve(null);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.resolve(null);
  }
  const mod = parsed.protocol === 'http:' ? http : https;
  return new Promise((resolve) => {
    try {
      mod.get(urlStr, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirects >= 5) return resolve(null);
          let next: string;
          try {
            next = new URL(res.headers.location, urlStr).toString();
          } catch {
            return resolve(null);
          }
          return resolve(fetchDirect(next, timeoutMs, redirects + 1));
        }
        if (status !== 200) { res.resume(); return resolve(null); }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null)).on('timeout', function (this: any) { this.destroy(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

// ── Catalog validation ───────────────────────────────────────────

/**
 * A remote catalog replaces the bundled one only when it is clearly complete.
 * (The old updater occasionally published files whose only entry was "error";
 * accepting those would erase every price.)
 */
export function isUsableCatalog(catalog: any, minProviders: number): boolean {
  if (!catalog || !Array.isArray(catalog.providers)) return false;
  // Only the v2 schema is trusted. Legacy files produced by the old AI-scraper
  // (nested shape, "error" models) must not overwrite the curated catalog.
  if (Number(catalog.schemaVersion) !== 2) return false;
  const usable = catalog.providers.filter((p: any) => {
    if (!p || !p.models || typeof p.models !== 'object') return false;
    return Object.values(p.models).some((m: any) => {
      if (!m || typeof m !== 'object') return false;
      const flat = m.input && typeof m.input === 'object' ? m.input : m;
      const output = Number(flat.output ?? m.output);
      const cacheMiss = Number(flat.cacheMiss);
      const cacheHit = Number(flat.cacheHit);
      return Number.isFinite(output) && Number.isFinite(cacheMiss) && Number.isFinite(cacheHit)
        && (output > 0 || cacheMiss > 0 || cacheHit > 0);
    });
  });
  return usable.length >= minProviders;
}

function applyCatalog(catalog: any): boolean {
  return setPricingCatalog(catalog as PricingCatalog);
}

function combinedCatalog(remote: any): any {
  // Legacy files put per-currency in `currency`; the catalog sanitizer accepts
  // both that and `nativeCurrency`, so no conversion is needed here. Keep the
  // exchange rates attached for the cache fallback.
  return remote;
}

/** Load the pricing.json shipped inside the VSIX (or repo root in dev). */
export function loadBundledPricing(extensionPath: string): boolean {
  const candidates = [
    path.join(extensionPath, 'pricing.json'),
    path.join(extensionPath, '..', 'pricing.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!isUsableCatalog(parsed, 3)) {
        console.warn(`[TokenMonitor] Bundled pricing ignored (not enough providers): ${file}`);
        continue;
      }
      if (applyCatalog(parsed)) {
        console.log(`[TokenMonitor] Bundled pricing loaded: ${file} (${parsed.updatedAt || 'no date'})`);
        return true;
      }
    } catch (err) {
      console.warn(`[TokenMonitor] Failed to load bundled pricing ${file}: ${String(err)}`);
    }
  }
  return false;
}

// ── Public updater ───────────────────────────────────────────────

export async function checkForUpdates(customUrl?: string, force = false): Promise<void> {
  const cacheFile = cachePath();
  const trimmedUrl = (customUrl || '').trim();
  if (trimmedUrl && !isHttpUrl(trimmedUrl)) {
    console.warn(`[TokenMonitor] Ignoring invalid pricing.updateUrl: ${trimmedUrl}`);
    return;
  }
  const sourceUrl = trimmedUrl || undefined;
  const deadline = Date.now() + TOTAL_FETCH_BUDGET;
  const proxyUrl = vscode.workspace.getConfiguration('http').get<string>('proxy') || '';

  // Rates: always try to fetch fresh from API (free, fast, no key needed).
  // This used to be skipped whenever a custom catalog URL was configured,
  // which left custom-hosted catalogs with stale exchange rates.
  const apiRates = await fetchRatesFromAPI(Math.min(RATES_TIMEOUT, remainingMs(deadline)), proxyUrl);
  if (apiRates) {
    setCustomRates(apiRates, Date.now(), 'remote');
    console.log('[TokenMonitor] Exchange rates updated from API');
  }

  // Catalog: check cache first, then the mirror list. A cache produced for a
  // different custom URL must not win, otherwise switching updateUrl appears
  // to do nothing for 24 hours.
  if (!force) {
    try {
      const stat = fs.statSync(cacheFile);
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      const cacheMatchesSource = !sourceUrl || cached?.source === sourceUrl;
      if (Date.now() - stat.mtimeMs < CACHE_TTL && cacheMatchesSource) {
        const catalog = combinedCatalog(cached);
        if (isUsableCatalog(catalog, sourceUrl ? 1 : 3) && applyCatalog(catalog)) {
          if (!hasFetchedRates() && cached?.rates) { setCustomRates(cached.rates, stat.mtimeMs, 'cache'); }
          // Only trust the cache when it covers exchange rates too. A cache
          // written before the catalog carried rates would otherwise pin the
          // display to the built-in table for a full day without ever asking
          // the network again; falling through lets it heal on the next run.
          if (hasFetchedRates()) return;
        }
      }
    } catch { /* cache missing */ }
  }

  const providerUrls = sourceUrl ? [sourceUrl] : PROVIDER_URLS;
  let remote: RemotePricing | null = null;
  let source = '';

  for (const url of providerUrls) {
    const budgetLeft = remainingMs(deadline);
    if (budgetLeft <= 0) {
      console.warn('[TokenMonitor] Pricing refresh exceeded its time budget; keeping the current catalog');
      break;
    }
    const timeoutMs = Math.min(FETCH_TIMEOUT, budgetLeft);
    const hasProxy = !!proxyUrl && proxyUrl.startsWith('http');
    const directFirst = prefersDirect(url);

    // Proxy first for hosts that need it (GitHub mirrors); direct first for
    // hosts that answer from mainland China (the OSS catalog).
    if (hasProxy && !directFirst) {
      remote = await fetchWithProxy(url, proxyUrl, timeoutMs);
      if (remote) { source = url; break; }
    }

    const directBudget = Math.min(FETCH_TIMEOUT, remainingMs(deadline));
    if (directBudget <= 0) break;
    remote = await fetchDirect(url, directBudget);
    if (remote) { source = url; break; }

    if (hasProxy && directFirst) {
      const proxyBudget = Math.min(FETCH_TIMEOUT, remainingMs(deadline));
      if (proxyBudget <= 0) break;
      remote = await fetchWithProxy(url, proxyUrl, proxyBudget);
      if (remote) { source = url; break; }
    }
  }

  if (remote) {
    const catalog = combinedCatalog(remote);
    const minProviders = sourceUrl ? 1 : 3;
    if (!isUsableCatalog(catalog, minProviders)) {
      console.warn(`[TokenMonitor] Remote pricing rejected (incomplete): ${source}`);
    } else if (applyCatalog(catalog)) {
      if (!hasFetchedRates() && remote.rates) { setCustomRates(remote.rates, Date.now(), 'remote'); }
      console.log(`[TokenMonitor] Model pricing updated: ${source} (${remote.updatedAt || getPricingUpdatedAt() || 'no date'})`);
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const cachePayload = {
          schemaVersion: 2,
          updatedAt: remote.updatedAt || new Date().toISOString(),
          providers: remote.providers,
          // Persist whichever rate table is actually in effect. The OSS catalog
          // carries no rates, so without this a later offline run has nothing to
          // restore and the UI can only fall back to the built-in table.
          rates: apiRates || remote.rates,
          ratesUpdatedAt: getRatesUpdatedAt(),
          holidays: remote.holidays,
          source,
        };
        fs.writeFileSync(cacheFile, JSON.stringify(cachePayload, null, 2), 'utf-8');
      } catch { /* cache write is best effort */ }
      return;
    }
  }

  // Fallback: cached data
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (!hasFetchedRates() && cached?.rates) {
      const stat = fs.statSync(cacheFile);
      setCustomRates(cached.rates, Number(cached?.ratesUpdatedAt) || stat.mtimeMs, 'cache');
    }
    if (cached?.providers && isUsableCatalog(cached, sourceUrl ? 1 : 3)) {
      applyCatalog(cached);
      console.log('[TokenMonitor] Using cached pricing data');
      return;
    }
  } catch { /* */ }

  if (!hasFetchedRates()) { setCustomRates(DEFAULT_RATES, 1, 'builtin'); }
  console.log('[TokenMonitor] Using bundled pricing (all remote sources unavailable)');
}