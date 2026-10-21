/**
 * Aliyun Bailian peak/off-peak semantics, verified against the official
 * DeepSeek pricing page: Monday–Friday 09:00–12:00 and 14:00–18:00 Beijing time
 * are peak; weekends, nights and Chinese statutory holidays are off-peak.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isDeepSeekOffPeak,
  calculateCostDetail,
  setPricingCatalog,
  getPricingCatalog,
} = require('../out/model/pricing.js');

/** Beijing wall-clock time → epoch ms. */
const beijing = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

const FLASH = 'deepseek-v4.1-flash';
const ONE_M_INPUT = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };

test('weekday peak windows are 09:00-12:00 and 14:00-18:00', () => {
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 9, 0)), false, '09:00 Wednesday is peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 11, 59)), false, '11:59 is peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 12, 0)), true, 'noon break is off-peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 14, 0)), false, '14:00 is peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 17, 59)), false, '17:59 is peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 18, 0)), true, '18:00 is off-peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 3, 0)), true, 'night is off-peak');
});

test('weekends are off-peak all day', () => {
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 24, 10, 0)), true, 'Saturday');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 25, 15, 0)), true, 'Sunday');
});

test('Chinese statutory holidays are off-peak even on a weekday', () => {
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 1, 10, 0)), true, 'National Day Thursday');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 7, 15, 0)), true, 'last day of National Day');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 2, 17, 10, 0)), true, 'Spring Festival');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 5, 4, 9, 30)), true, 'Labour Day Monday');
  assert.equal(isDeepSeekOffPeak(beijing(2025, 10, 6, 10, 0)), true, '2025 National Day Monday');
  assert.equal(isDeepSeekOffPeak(beijing(2024, 2, 12, 10, 0)), true, '2024 Spring Festival Monday');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 8, 10, 0)), false, 'day after the break is peak again');
});

test('unknown timestamps are treated as peak (the conservative price)', () => {
  assert.equal(isDeepSeekOffPeak(0), false);
  assert.equal(isDeepSeekOffPeak(NaN), false);
});

test('cost uses half price off-peak and the full price at peak', () => {
  const peak = calculateCostDetail(FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 10, 0));
  const off = calculateCostDetail(FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 20, 0));
  assert.equal(peak.known, true);
  assert.equal(peak.amount, 2.0, '1M cache-miss tokens at peak cost 2 CNY');
  assert.equal(off.amount, 1.0, 'off-peak is half price');
});

test('the peak rule belongs to the model, not to the provider id', () => {
  const original = getPricingCatalog();
  try {
    // A DeepSeek model served by the official API or a relay, not by Bailian.
    setPricingCatalog({
      schemaVersion: 2,
      providers: [{
        id: 'deepseek',
        name: 'DeepSeek',
        nativeCurrency: 'CNY',
        matchPattern: /deepseek/i,
        models: {
          'deepseek-flash': {
            cacheHit: 0.04, cacheMiss: 2, output: 8,
            offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
          },
        },
      }],
    });
    const peak = calculateCostDetail('deepseek-flash', ONE_M_INPUT, beijing(2026, 10, 21, 10, 0));
    const off = calculateCostDetail('deepseek-flash', ONE_M_INPUT, beijing(2026, 10, 21, 20, 0));
    assert.equal(peak.amount, 2.0);
    assert.equal(off.amount, 1.0, 'off-peak applies under any provider id');
  } finally {
    setPricingCatalog(original);
  }
});

test('models without an off-peak table keep one price around the clock', () => {
  const peak = calculateCostDetail('qwen3.5-plus', ONE_M_INPUT, beijing(2026, 10, 21, 10, 0));
  const off = calculateCostDetail('qwen3.5-plus', ONE_M_INPUT, beijing(2026, 10, 21, 20, 0));
  assert.equal(peak.amount, 0.8);
  assert.equal(off.amount, 0.8, 'Qwen is not a DeepSeek model and has no peak/off-peak pricing');
});

test('the remote catalog can extend the holiday table without a release', () => {
  const original = getPricingCatalog();
  try {
    assert.equal(isDeepSeekOffPeak(beijing(2026, 12, 31, 10, 0)), false, 'New Year Eve is a normal Thursday');
    const applied = setPricingCatalog({
      schemaVersion: 2,
      providers: original.providers,
      holidays: ['2026-12-31'],
    });
    assert.equal(applied, true);
    assert.equal(isDeepSeekOffPeak(beijing(2026, 12, 31, 10, 0)), true, 'catalog holiday is honoured');
  } finally {
    setPricingCatalog(original);
  }
  assert.equal(isDeepSeekOffPeak(beijing(2026, 12, 31, 10, 0)), false, 'restored catalog drops the extra date');
});

test('malformed holiday entries are ignored', () => {
  const original = getPricingCatalog();
  try {
    setPricingCatalog({ schemaVersion: 2, providers: original.providers, holidays: ['not-a-date', 123, ''] });
    assert.equal(isDeepSeekOffPeak(beijing(2026, 12, 31, 10, 0)), false);
  } finally {
    setPricingCatalog(original);
  }
});