#!/usr/bin/env node
/**
 * Daily model-pricing updater for the v2 pricing catalog.
 *
 *   node scripts/update-pricing.js              # update pricing.json
 *   node scripts/update-pricing.js --dry-run    # report changes, write nothing
 *   node scripts/update-pricing.js --validate   # validate pricing.json only
 *
 * The catalog is merged, never replaced:
 *   1. every existing model/price is kept unless a fresh, trustworthy value replaces it
 *   2. scraped values must pass strict numeric/sanity checks
 *   3. a price that moves more than MAX_PRICE_JUMP× is rejected as a parse error
 *   4. pricing-overrides.json (human-reviewed) always wins
 *
 * AI backend: BAILIAN_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY.
 */

const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRICING_PATH = path.join(ROOT, 'pricing.json');
const OVERRIDES_PATH = path.join(ROOT, 'pricing-overrides.json');
const MAX_PRICE_JUMP = 5;
const FETCH_TIMEOUT = 15000;
const DIRECT_TIMEOUT = 8000;
const USER_AGENT = 'Mozilla/5.0 (compatible; CCTM-pricing-bot/2.0)';

// ─── Outbound proxy ─────────────────────────────────────────────
// Foreign vendor pages need a proxy on a mainland server. HTTPS_PROXY
// (or HTTP_PROXY) is honoured through a CONNECT tunnel so the normal
// https client keeps handling chunked encoding and TLS.

function buildProxyAgent() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return null;
  let proxy;
  try { proxy = new URL(raw); } catch { return null; }
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    const socket = net.connect(proxyPort, proxyHost, () => {
      socket.write(`CONNECT ${options.host}:${options.port} HTTP/1.1\r\n`
        + `Host: ${options.host}:${options.port}\r\nProxy-Connection: keep-alive\r\n\r\n`);
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('latin1');
        if (!buffer.includes('\r\n\r\n')) return;
        socket.removeListener('data', onData);
        if (!/^HTTP\/1\.[01] 200/.test(buffer)) {
          socket.destroy();
          return callback(new Error(`proxy CONNECT refused: ${buffer.split('\r\n')[0]}`));
        }
        const secured = tls.connect({ socket, servername: options.host, rejectUnauthorized: true },
          () => callback(null, secured));
        secured.on('error', callback);
      };
      socket.on('data', onData);
    });
    socket.on('error', callback);
  };
  return agent;
}

const PROXY_AGENT = buildProxyAgent();

// ─── Sources ────────────────────────────────────────────────────
// `id` must match the provider id in pricing.json; a provider is only
// updated in place, never renamed.

const SOURCES = [
  {
    id: 'aliyun-bailian',
    name: 'Aliyun Bailian',
    currency: 'CNY',
    urls: [
      'https://help.aliyun.com/zh/model-studio/models',
      'https://help.aliyun.com/zh/model-studio/getting-started/models',
    ],
    search: '阿里云百炼 模型 计费 价格 每千 tokens',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    currency: 'USD',
    urls: ['https://www.anthropic.com/pricing', 'https://docs.anthropic.com/en/docs/about-claude/pricing'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    currency: 'USD',
    urls: ['https://openai.com/api/pricing/', 'https://platform.openai.com/docs/pricing'],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    currency: 'USD',
    urls: ['https://ai.google.dev/gemini-api/docs/pricing', 'https://cloud.google.com/vertex-ai/generative-ai/pricing'],
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    currency: 'USD',
    urls: ['https://platform.moonshot.cn/docs/pricing/chat', 'https://platform.moonshot.ai/docs/pricing/chat'],
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    currency: 'CNY',
    urls: ['https://open.bigmodel.cn/pricing', 'https://docs.bigmodel.cn/cn/guide/start/model-overview'],
  },
  {
    id: 'bytedance',
    name: 'ByteDance Doubao',
    currency: 'CNY',
    urls: ['https://www.volcengine.com/docs/82379/1099320', 'https://www.volcengine.com/pricing?product=ark'],
    search: 'site:volcengine.com 豆包 Doubao 模型 价格 每百万 tokens',
  },
  {
    id: 'baidu',
    name: 'Baidu Ernie',
    currency: 'CNY',
    urls: ['https://cloud.baidu.com/doc/WENXINWORKSHOP/s/hlrk4akp7'],
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    currency: 'USD',
    urls: ['https://docs.x.ai/docs/models', 'https://x.ai/api'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    currency: 'USD',
    urls: ['https://mistral.ai/pricing', 'https://docs.mistral.ai/getting-started/models/models_overview/'],
  },
];

// ─── AI backend ─────────────────────────────────────────────────

function getAIConfig() {
  const openaiCompatible = (name, key, hostname, model, requestPath = '/v1/chat/completions') => ({
    name,
    key,
    hostname,
    path: requestPath,
    model,
    buildBody: (msg) => JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You extract structured pricing data. Reply with a single JSON object, no markdown.' },
        { role: 'user', content: msg },
      ],
      max_tokens: 4096,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    parseResponse: (data) => parseFirstJson(JSON.parse(data).choices?.[0]?.message?.content),
  });

  if (process.env.BAILIAN_API_KEY) {
    // DashScope's OpenAI-compatible endpoint. The bare /v1/... path is the
    // native API and 404s here; the model id needs its dated suffix.
    return openaiCompatible(
      'bailian',
      process.env.BAILIAN_API_KEY,
      'dashscope.aliyuncs.com',
      process.env.BAILIAN_MODEL || 'deepseek-v4.1-flash-1017',
      '/compatible-mode/v1/chat/completions',
    );
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return openaiCompatible('deepseek', process.env.DEEPSEEK_API_KEY, 'api.deepseek.com', 'deepseek-chat');
  }
  if (process.env.OPENAI_API_KEY) {
    return openaiCompatible('openai', process.env.OPENAI_API_KEY, 'api.openai.com', 'gpt-4o-mini');
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: 'anthropic',
      key: process.env.ANTHROPIC_API_KEY,
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      model: 'claude-sonnet-4-5',
      buildBody: (msg) => JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        system: 'You extract structured pricing data. Reply with a single JSON object, no markdown.',
        messages: [{ role: 'user', content: msg }],
      }),
      parseResponse: (data) => parseFirstJson(JSON.parse(data).content?.[0]?.text),
    };
  }
  return null;
}

function parseFirstJson(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function callAI(ai, userMessage) {
  const body = ai.buildBody(userMessage);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  if (ai.name === 'anthropic') {
    headers['x-api-key'] = ai.key;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.Authorization = `Bearer ${ai.key}`;
  }
  const send = (agent) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: ai.hostname, path: ai.path, method: 'POST', agent: agent || undefined, headers, timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`API ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(ai.parseResponse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
  // The AI endpoint is domestic, so try direct first and only fall back to the
  // proxy when the host itself needs one.
  return send(null).catch((err) => {
    if (!PROXY_AGENT) throw err;
    return send(PROXY_AGENT);
  });
}

// ─── HTTP ───────────────────────────────────────────────────────

function httpsGet(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('too many redirects'));
  const request = (agent, timeoutMs) => new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, agent: agent || undefined, headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en,zh-CN;q=0.8' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpsGet(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
  // Direct first: mainland-hosted sites are faster and some (anthropic.com)
  // only answer directly. Fall back to the proxy for the rest.
  return request(null, DIRECT_TIMEOUT).catch((directError) => {
    if (!PROXY_AGENT) throw directError;
    return request(PROXY_AGENT, FETCH_TIMEOUT);
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40000);
}

async function searchWeb(query) {
  for (const url of [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`,
  ]) {
    try {
      const html = await httpsGet(url);
      const text = htmlToText(html);
      if (text.length > 200) return text;
    } catch { /* next engine */ }
  }
  return '';
}

// ─── Validation ─────────────────────────────────────────────────

function isFinitePositive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Normalize a model key exactly like src/model/pricing.ts does. */
function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

/**
 * Accept a model only when every required field is numeric and the ratios look
 * like real pricing. Returns null for anything suspicious.
 */
function sanitizeModel(raw) {
  if (!raw) return null;
  const flat = raw.input && typeof raw.input === 'object' ? raw.input : raw;
  const cacheHit = Number(flat.cacheHit ?? flat.cache_hit ?? 0);
  const cacheMiss = Number(flat.cacheMiss ?? flat.cache_miss ?? flat.input);
  const output = Number(flat.output);
  if (![cacheHit, cacheMiss, output].every(isFinitePositive)) return null;
  if (cacheMiss <= 0 || output <= 0) return null;
  if (cacheHit > cacheMiss) return null;
  if (output < cacheMiss / 50 || output > cacheMiss * 100) return null;
  const model = { cacheHit, cacheMiss, output };
  if (flat.cacheWrite !== undefined) {
    const cacheWrite = Number(flat.cacheWrite);
    if (isFinitePositive(cacheWrite) && cacheWrite > 0) model.cacheWrite = cacheWrite;
  }
  const offPeak = flat.offPeak || flat.off_peak;
  if (offPeak && typeof offPeak === 'object') {
    const op = sanitizeModel({ ...offPeak, cacheHit: offPeak.cacheHit ?? 0 });
    if (op) model.offPeak = { cacheHit: op.cacheHit, cacheMiss: op.cacheMiss, output: op.output };
  }
  return model;
}

/** Reject a fresh price that is implausibly far from the current one. */
function isPlausibleJump(next, current) {
  if (!current) return true;
  for (const field of ['cacheHit', 'cacheMiss', 'output']) {
    const a = next[field], b = current[field];
    if (a === undefined || b === undefined) continue;
    if (b === 0 ? a > 0 : a > b * MAX_PRICE_JUMP || a < b / MAX_PRICE_JUMP) return false;
  }
  return true;
}

function validateCatalog(catalog) {
  const problems = [];
  if (catalog.schemaVersion !== 2) problems.push('schemaVersion must be 2');
  if (!Array.isArray(catalog.providers) || catalog.providers.length === 0) problems.push('providers must be a non-empty array');
  for (const provider of catalog.providers || []) {
    if (!provider.id) problems.push('provider missing id');
    if (!provider.nativeCurrency) problems.push(`${provider.id}: missing nativeCurrency`);
    if (!provider.models || Object.keys(provider.models).length === 0) {
      problems.push(`${provider.id}: no models`);
      continue;
    }
    for (const [key, model] of Object.entries(provider.models)) {
      if (!sanitizeModel(model)) problems.push(`${provider.id}/${key}: invalid pricing`);
    }
  }
  return problems;
}

// ─── Update ─────────────────────────────────────────────────────

async function extractProvider(ai, source) {
  const urls = source.urls || [];
  for (const url of urls) {
    try {
      const text = htmlToText(await httpsGet(url));
      if (text.length < 200) continue;
      const json = await callAI(ai,
        `Extract the official list price of every text-generation model from the page below.\n` +
        `Return one JSON object shaped as {"model-key": {"cacheHit": number, "cacheMiss": number, "output": number}}.\n` +
        `All values are ${source.currency} per 1,000,000 tokens. cacheMiss is normal input, cacheHit is cached input (0 if the model has no cache discount), output is generated output.\n` +
        `Use lowercase model keys exactly as published (e.g. "claude-sonnet-4-5", "deepseek-v4.1-flash"). Do not invent models, do not include free/example/error rows.\n\n` +
        `PAGE (${url}):\n${text}`);
      const models = sanitizeExtraction(json);
      if (Object.keys(models).length > 0) return { models, from: url };
    } catch (e) {
      console.log(`    ${url} failed: ${e.message}`);
    }
  }

  if (source.search) {
    try {
      const text = await searchWeb(source.search);
      if (text.length > 200) {
        const json = await callAI(ai,
          `From these search results, extract the current official ${source.name} model list prices.\n` +
          `Return JSON as {"model-key": {"cacheHit": number, "cacheMiss": number, "output": number}} in ${source.currency} per 1M tokens.\n` +
          `Do not invent models.\n\nRESULTS:\n${text}`);
        const models = sanitizeExtraction(json);
        const from = 'web-search';
        if (Object.keys(models).length > 0) return { models, from };
      }
    } catch (e) {
      console.log(`    web search failed: ${e.message}`);
    }
  }
  return null;
}

function sanitizeExtraction(json) {
  const out = {};
  if (!json || typeof json !== 'object') return out;
  for (const [rawKey, rawModel] of Object.entries(json)) {
    if (rawKey === 'models' && rawModel && typeof rawModel === 'object') {
      Object.assign(out, sanitizeExtraction(rawModel));
      continue;
    }
    const key = normalizeKey(rawKey);
    if (!key || /^(error|note|notes|example|currency|source)$/.test(key)) continue;
    if (key.length > 80) continue;
    const model = sanitizeModel(rawModel);
    if (model) out[key] = model;
  }
  return out;
}

function mergeProvider(provider, extracted, dateStamp) {
  let added = 0, updated = 0, rejected = 0;
  for (const [key, next] of Object.entries(extracted)) {
    const current = provider.models[key];
    if (!isPlausibleJump(next, current)) {
      console.log(`    ! ${key}: rejected implausible jump (${JSON.stringify(next)} vs ${JSON.stringify(current)})`);
      rejected++;
      continue;
    }
    if (!current) {
      provider.models[key] = { ...next, verified: `auto-${dateStamp}` };
      added++;
    } else if (isSamePricing(current, next)) {
      if (!current.verified) current.verified = `auto-${dateStamp}`;
    } else {
      provider.models[key] = { ...next, verified: `auto-${dateStamp}` };
      updated++;
    }
  }
  return { added, updated, rejected };
}

function isSamePricing(a, b) {
  for (const field of ['cacheHit', 'cacheMiss', 'output', 'cacheWrite']) {
    if ((a[field] || 0) !== (b[field] || 0)) return false;
  }
  const ao = a.offPeak || {}, bo = b.offPeak || {};
  for (const field of ['cacheHit', 'cacheMiss', 'output']) {
    if ((ao[field] || 0) !== (bo[field] || 0)) return false;
  }
  return true;
}

/** Human-reviewed values win over everything the scraper produced. */
function applyOverrides(catalog, overrides) {
  if (!overrides || typeof overrides !== 'object') return 0;
  let applied = 0;
  for (const [providerId, models] of Object.entries(overrides)) {
    const provider = catalog.providers.find((p) => p.id === providerId);
    if (!provider) { console.log(`  override: unknown provider ${providerId}, skipped`); continue; }
    for (const [rawKey, rawModel] of Object.entries(models || {})) {
      const key = normalizeKey(rawKey);
      const model = sanitizeModel(rawModel);
      if (!model) { console.log(`  override: invalid ${providerId}/${key}, skipped`); continue; }
      provider.models[key] = { ...model, verified: rawModel.verified || `manual-${new Date().toISOString().slice(0, 10)}` };
      if (rawModel.notes) provider.models[key].notes = String(rawModel.notes);
      applied++;
    }
  }
  return applied;
}

/** Read `--name=value`, `--name value`, or a bare `--flag`. */
function getArg(name, fallback = '') {
  const argv = process.argv.slice(2);
  const prefix = name + '=';
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith(prefix)) return token.slice(prefix.length);
    if (token === name) {
      const next = argv[i + 1];
      return next && !next.startsWith('--') ? next : '';
    }
  }
  return fallback;
}

async function fetchRates() {
  try {
    const raw = await httpsGet('https://open.er-api.com/v6/latest/USD');
    const parsed = JSON.parse(raw);
    if (parsed?.result === 'success' && parsed?.rates) return parsed.rates;
  } catch { /* rates are optional */ }
  return null;
}

/** Offline checks: no AI key, no network. Used by CI and the server cron. */
function selfTest() {
  const problems = [];
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf-8'));
  } catch (e) {
    console.error(`self-test: cannot read pricing.json: ${e.message}`);
    process.exit(1);
  }
  problems.push(...validateCatalog(catalog));

  const good = sanitizeModel({ cacheHit: 0.04, cacheMiss: 2, output: 8 });
  if (!good) problems.push('sanitizeModel rejected a valid entry');

  const badEntries = [
    { cacheHit: 3, cacheMiss: 2, output: 8 },
    { cacheHit: 0, cacheMiss: 2, output: 0 },
    { cacheHit: 0, cacheMiss: -1, output: 8 },
    { cacheHit: 0, cacheMiss: 2, output: 100000 },
  ];
  for (const bad of badEntries) {
    if (sanitizeModel(bad)) problems.push(`sanitizeModel accepted invalid entry ${JSON.stringify(bad)}`);
  }

  if (isPlausibleJump({ cacheHit: 0, cacheMiss: 11, output: 30 }, { cacheHit: 0, cacheMiss: 2, output: 8 })) {
    problems.push('isPlausibleJump accepted a >5x jump');
  }
  if (!isPlausibleJump({ cacheHit: 0, cacheMiss: 2.2, output: 8.4 }, { cacheHit: 0, cacheMiss: 2, output: 8 })) {
    problems.push('isPlausibleJump rejected a normal change');
  }

  if (fs.existsSync(OVERRIDES_PATH)) {
    const copy = JSON.parse(JSON.stringify(catalog));
    applyOverrides(copy, JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8')));
    problems.push(...validateCatalog(copy).map((p) => `after overrides: ${p}`));
  }

  if (problems.length) {
    console.error(`self-test FAILED (${problems.length} problems):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`self-test OK — ${catalog.providers.length} providers, ` +
    `${catalog.providers.reduce((n, p) => n + Object.keys(p.models).length, 0)} models`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const validateOnly = process.argv.includes('--validate');
  const targetPath = path.resolve(getArg('--out', PRICING_PATH));
  const providerFilter = new Set(
    getArg('--providers', '').split(',').map((s) => s.trim()).filter(Boolean)
  );

  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  const catalog = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));

  if (validateOnly) {
    const problems = validateCatalog(catalog);
    if (problems.length) {
      console.error(`${targetPath} is invalid (${problems.length} problems):`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`${targetPath} OK — ${catalog.providers.length} providers, ` +
      `${catalog.providers.reduce((n, p) => n + Object.keys(p.models).length, 0)} models`);
    return;
  }

  if (providerFilter.size > 0) {
    const known = new Set(SOURCES.map((s) => s.id));
    for (const id of providerFilter) {
      if (!known.has(id)) {
        console.error(`Unknown provider id: ${id}. Known: ${[...known].join(', ')}`);
        process.exit(2);
      }
    }
  }

  const ai = getAIConfig();
  if (!ai) {
    console.error('No AI backend configured. Set BAILIAN_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY.');
    process.exit(2);
  }
  console.log(`AI backend: ${ai.name} (${ai.model})`);

  const today = new Date().toISOString().slice(0, 10);
  let added = 0, updated = 0, rejected = 0, failed = 0;

  for (const source of SOURCES) {
    if (providerFilter.size > 0 && !providerFilter.has(source.id)) continue;
    const provider = catalog.providers.find((p) => p.id === source.id);
    if (!provider) { console.log(`${source.id}: not in catalog, skipped`); continue; }
    console.log(`${source.name} (${source.id})...`);
    const extracted = await extractProvider(ai, source);
    if (!extracted) {
      console.log('    FAIL — keeping existing prices');
      failed++;
      continue;
    }
    const stats = mergeProvider(provider, extracted.models, today);
    added += stats.added; updated += stats.updated; rejected += stats.rejected;
    console.log(`    from ${extracted.from}: ${Object.keys(extracted.models).length} models, ` +
      `+${stats.added} new, ${stats.updated} changed, ${stats.rejected} rejected`);
  }

  const overrides = fs.existsSync(OVERRIDES_PATH)
    ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8'))
    : null;
  const overrideCount = applyOverrides(catalog, overrides);
  if (overrideCount) console.log(`Applied ${overrideCount} human-reviewed override(s).`);

  catalog.schemaVersion = 2;
  catalog.updatedAt = today;
  catalog.source = `auto:${ai.name}+official+manual-overrides`;

  if (process.argv.includes('--rates')) {
    const rates = await fetchRates();
    if (rates) {
      catalog.rates = rates;
      console.log(`Attached live exchange rates (1 USD = ${rates.CNY} CNY).`);
    } else {
      console.log('Exchange-rate fetch failed; catalog.rates left unchanged.');
    }
  }

  const problems = validateCatalog(catalog);
  if (problems.length) {
    console.error('Refusing to write an invalid catalog:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const before = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  const changed = JSON.stringify(before) !== JSON.stringify(catalog);
  console.log(`\nSummary: +${added} models, ${updated} price changes, ${rejected} rejected, ${failed} providers failed.`);

  if (dryRun) {
    console.log(changed ? `${targetPath} would change.` : 'DRY RUN — no changes.');
    return;
  }
  if (!changed) {
    console.log('No changes — pricing.json untouched.');
    return;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(catalog, null, 2) + '\n', 'utf-8');
  console.log(`${targetPath} written.`);
}

main().catch((e) => { console.error(e); process.exit(1); });