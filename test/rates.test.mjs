/**
 * Exchange-rate provenance.
 *
 * A rate is always in effect — remote fetch, restored cache, or the compiled-in
 * table — so the UI must never say "unknown". These tests pin the payload
 * normaliser (three different free APIs) and the source bookkeeping that the
 * status-bar tooltip reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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
const { normalizeRates, fetchRatesFromAPI } = require('../out/model/pricing-fetcher.js');
const {
  setCustomRates,
  getRatesSource,
  getRatesUpdatedAt,
  hasFetchedRates,
  convertCurrency,
  DEFAULT_RATES,
} = require('../out/model/pricing.js');
Module._load = originalLoad;

test('normalizeRates reads the open.er-api.com shape', () => {
  const rates = normalizeRates({
    result: 'success',
    base_code: 'USD',
    rates: { USD: 1, CNY: 6.689, EUR: 0.89, JPY: 158.1, KRW: 1326.1, GBP: 0.746 },
  });
  assert.equal(rates.USD, 1);
  assert.equal(rates.CNY, 6.689);
  assert.equal(rates.EUR, 0.89);
});

test('normalizeRates reads the frankfurter.dev shape and adds USD', () => {
  const rates = normalizeRates({ base: 'USD', rates: { CNY: 6.7, EUR: 0.9 } });
  assert.equal(rates.USD, 1, 'USD is omitted by frankfurter and must be re-added');
  assert.equal(rates.CNY, 6.7);
});

test('normalizeRates reads the fawazahmed currency-api shape (lowercase, nested)', () => {
  const rates = normalizeRates({ date: '2026-10-22', usd: { cny: 6.7, eur: 0.9, usd: 1 } });
  assert.equal(rates.CNY, 6.7);
  assert.equal(rates.EUR, 0.9);
  assert.equal(rates.USD, 1);
});

test('normalizeRates rejects payloads with no usable rate table', () => {
  assert.equal(normalizeRates(null), null);
  assert.equal(normalizeRates('nope'), null);
  assert.equal(normalizeRates({}), null);
  assert.equal(normalizeRates({ result: 'error', rates: { CNY: 6.7 } }), null);
  assert.equal(normalizeRates({ result: 'success', rates: {} }), null, 'empty table');
  assert.equal(normalizeRates({ result: 'success', rates: { CNY: 0 } }), null, 'non-positive rate');
  assert.equal(normalizeRates({ result: 'success', rates: { XYZ: 3 } }), null, 'no display currency');
});

test('a rate source starts at builtin and is always usable', () => {
  // Fresh module state: no fetch has happened, but a rate is still in effect.
  assert.equal(getRatesSource(), 'builtin');
  assert.equal(getRatesUpdatedAt(), 0);
  assert.equal(hasFetchedRates(), false);
  assert.equal(convertCurrency(1, 'USD', 'CNY'), DEFAULT_RATES.CNY);
});

test('fetched rates switch the source to remote and drive conversion', () => {
  setCustomRates({ USD: 1, CNY: 5 }, 1_700_000_000_000, 'remote');
  assert.equal(getRatesSource(), 'remote');
  assert.equal(hasFetchedRates(), true);
  assert.equal(getRatesUpdatedAt(), 1_700_000_000_000);
  assert.equal(convertCurrency(2, 'USD', 'CNY'), 10);
});

test('cached rates are reported as cache, not as remote', () => {
  setCustomRates({ USD: 1, CNY: 7 }, 1_700_000_000_000, 'cache');
  assert.equal(getRatesSource(), 'cache');
  assert.equal(hasFetchedRates(), true);
  assert.equal(convertCurrency(1, 'USD', 'CNY'), 7);
});

test('falling back to the built-in table resets the source', () => {
  setCustomRates(DEFAULT_RATES, 1, 'builtin');
  assert.equal(getRatesSource(), 'builtin');
  assert.equal(hasFetchedRates(), false);
  assert.equal(convertCurrency(1, 'USD', 'CNY'), DEFAULT_RATES.CNY);
});

test('setCustomRates drops non-numeric and non-positive entries', () => {
  setCustomRates({ USD: 1, CNY: 'oops', EUR: -3, JPY: 150 }, 1, 'remote');
  assert.equal(convertCurrency(1, 'USD', 'CNY'), DEFAULT_RATES.CNY, 'invalid CNY ignored, built-in used');
  assert.equal(convertCurrency(1, 'USD', 'JPY'), 150);
});

test('fetchRatesFromAPI never throws on a dead endpoint list', async () => {
  // Timeout of 1ms means every attempt is skipped immediately.
  const result = await fetchRatesFromAPI(1);
  assert.equal(result, null);
});