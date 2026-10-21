/**
 * Pricing fetch contract: the OSS catalog is the primary source, redirects are
 * followed, and every failure mode resolves to null so the next mirror gets a
 * chance instead of the whole refresh aborting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// pricing-fetcher imports 'vscode' at module scope; only workspace config is
// touched (and only inside checkForUpdates), so a minimal stub is enough.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
      Uri: {},
    };
  }
  return originalLoad.apply(this, arguments);
};
const { fetchDirect, isUsableCatalog, PROVIDER_URLS, OSS_PRICING_URL } =
  require('../out/model/pricing-fetcher.js');
Module._load = originalLoad;

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function stopServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('the OSS catalog is the first source and every fallback is https', () => {
  assert.equal(PROVIDER_URLS[0], OSS_PRICING_URL);
  assert.match(OSS_PRICING_URL, /^https:\/\/cctm-pricing\.oss-cn-shenzhen\.aliyuncs\.com\/pricing\.json$/);
  for (const url of PROVIDER_URLS) {
    assert.match(url, /^https:\/\//, `source must use TLS: ${url}`);
  }
  assert.equal(new Set(PROVIDER_URLS).size, PROVIDER_URLS.length, 'no duplicate sources');
});

test('fetchDirect returns parsed JSON and follows relative redirects', async () => {
  const { server, base } = await startServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"schemaVersion":2,"providers":[]}');
      return;
    }
    if (req.url === '/302') {
      res.writeHead(302, { Location: '/ok' });
      res.end();
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
      return;
    }
    if (req.url === '/absolute') {
      res.writeHead(301, { Location: `${base}/ok` });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });

  try {
    assert.deepEqual(await fetchDirect(`${base}/ok`, 2000), { schemaVersion: 2, providers: [] });
    assert.deepEqual(await fetchDirect(`${base}/302`, 2000), { schemaVersion: 2, providers: [] });
    assert.deepEqual(await fetchDirect(`${base}/absolute`, 2000), { schemaVersion: 2, providers: [] });
    assert.equal(await fetchDirect(`${base}/loop`, 2000), null, 'redirect loop stops after 5 hops');
    assert.equal(await fetchDirect(`${base}/gone`, 2000), null, '404 is a failed source');
  } finally {
    await stopServer(server);
  }
});

test('fetchDirect rejects a 200 that is not JSON', async () => {
  const { server, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>rate limited</html>');
  });
  try {
    assert.equal(await fetchDirect(`${base}/bad`, 2000), null);
  } finally {
    await stopServer(server);
  }
});

test('fetchDirect times out instead of hanging the refresh', async () => {
  const { server, base } = await startServer(() => { /* never responds */ });
  try {
    const started = Date.now();
    assert.equal(await fetchDirect(`${base}/slow`, 150), null);
    assert.ok(Date.now() - started < 2000, 'timeout is honoured');
  } finally {
    await stopServer(server);
  }
});

test('fetchDirect rejects unsupported protocols without touching the network', async () => {
  assert.equal(await fetchDirect('file:///c:/pricing.json', 500), null);
  assert.equal(await fetchDirect('not a url', 500), null);
  assert.equal(await fetchDirect('http://127.0.0.1:1/x', 0), null);
});

test('isUsableCatalog only trusts a complete v2 catalog', () => {
  const model = { cacheHit: 1, cacheMiss: 2, output: 3 };
  const v2 = { schemaVersion: 2, providers: [{ id: 'p', name: 'P', models: { m: model } }] };
  assert.equal(isUsableCatalog(v2, 1), true);
  assert.equal(isUsableCatalog({ ...v2, schemaVersion: 1 }, 1), false, 'legacy schema rejected');
  assert.equal(isUsableCatalog({ schemaVersion: 2, providers: [] }, 1), false, 'empty catalog rejected');

  const errorOnly = {
    schemaVersion: 2,
    providers: [{ id: 'p', models: { error: { cacheHit: 0, cacheMiss: 0, output: 0 } } }],
  };
  assert.equal(isUsableCatalog(errorOnly, 1), false, 'error placeholder is not usable pricing');

  const zeroed = {
    schemaVersion: 2,
    providers: [{ id: 'p', models: { m: { cacheHit: 0, cacheMiss: 0, output: 0 } } }],
  };
  assert.equal(isUsableCatalog(zeroed, 1), false, 'all-zero prices are not usable');
});