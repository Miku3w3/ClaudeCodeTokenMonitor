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
  isBailianOffPeak,
  calculateCostDetail,
  setBailianPeakPricingEnabled,
  setPricingCatalog,
  getPricingCatalog,
} = require('../out/model/pricing.js');

/** Beijing wall-clock time → epoch ms. */
const beijing = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

const FLASH = 'deepseek-v4.1-flash';
const ONE_M_INPUT = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };

test('weekday peak windows are 09:00-12:00 and 14:00-18:00', () => {
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 9, 0)), false, '09:00 Wednesday is peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 11, 59)), false, '11:59 is peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 12, 0)), true, 'noon break is off-peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 14, 0)), false, '14:00 is peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 17, 59)), false, '17:59 is peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 18, 0)), true, '18:00 is off-peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 3, 0)), true, 'night is off-peak');
});

test('weekends are off-peak all day', () => {
  assert.equal(isBailianOffPeak(beijing(2026, 10, 24, 10, 0)), true, 'Saturday');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 25, 15, 0)), true, 'Sunday');
});

test('Chinese statutory holidays are off-peak even on a weekday', () => {
  assert.equal(isBailianOffPeak(beijing(2026, 10, 1, 10, 0)), true, 'National Day Thursday');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 7, 15, 0)), true, 'last day of National Day');
  assert.equal(isBailianOffPeak(beijing(2026, 2, 17, 10, 0)), true, 'Spring Festival');
  assert.equal(isBailianOffPeak(beijing(2026, 5, 4, 9, 30)), true, 'Labour Day Monday');
  assert.equal(isBailianOffPeak(beijing(2025, 10, 6, 10, 0)), true, '2025 National Day Monday');
  assert.equal(isBailianOffPeak(beijing(2024, 2, 12, 10, 0)), true, '2024 Spring Festival Monday');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 8, 10, 0)), false, 'day after the break is peak again');
});

test('unknown timestamps are treated as peak (the conservative price)', () => {
  assert.equal(isBailianOffPeak(0), false);
  assert.equal(isBailianOffPeak(NaN), false);
});

test('cost uses half price off-peak and the full price at peak', () => {
  setBailianPeakPricingEnabled(true);
  const peak = calculateCostDetail(FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 10, 0));
  const off = calculateCostDetail(FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 20, 0));
  assert.equal(peak.known, true);
  assert.equal(peak.amount, 2.0, '1M cache-miss tokens at peak cost 2 CNY');
  assert.equal(off.amount, 1.0, 'off-peak is half price');
});

test('the peak-pricing switch freezes every message at the peak price', () => {
  setBailianPeakPricingEnabled(false);
  const off = calculateCostDetail(FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 20, 0));
  assert.equal(off.amount, 2.0, 'off-peak timestamp is billed at peak when disabled');
  setBailianPeakPricingEnabled(true);
  const restored = calculateCostDetail(FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 20, 0));
  assert.equal(restored.amount, 1.0);
});

test('the remote catalog can extend the holiday table without a release', () => {
  const original = getPricingCatalog();
  try {
    assert.equal(isBailianOffPeak(beijing(2026, 12, 31, 10, 0)), false, 'New Year Eve is a normal Thursday');
    const applied = setPricingCatalog({
      schemaVersion: 2,
      providers: original.providers,
      holidays: ['2026-12-31'],
    });
    assert.equal(applied, true);
    assert.equal(isBailianOffPeak(beijing(2026, 12, 31, 10, 0)), true, 'catalog holiday is honoured');
  } finally {
    setPricingCatalog(original);
  }
  assert.equal(isBailianOffPeak(beijing(2026, 12, 31, 10, 0)), false, 'restored catalog drops the extra date');
});

test('malformed holiday entries are ignored', () => {
  const original = getPricingCatalog();
  try {
    setPricingCatalog({ schemaVersion: 2, providers: original.providers, holidays: ['not-a-date', 123, ''] });
    assert.equal(isBailianOffPeak(beijing(2026, 12, 31, 10, 0)), false);
  } finally {
    setPricingCatalog(original);
  }
});