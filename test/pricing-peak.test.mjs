/**
 * Peak/off-peak semantics for the two DeepSeek channels.
 *
 * Bailian bills every day 08:00–22:00 as peak (22:00–08:00 off-peak);
 * the DeepSeek official API bills Monday–Friday 09:00–12:00 and 14:00–18:00
 * as peak and treats weekends, holidays and nights as off-peak.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isBailianOffPeak,
  isDeepSeekOffPeak,
  calculateCostDetail,
  setPricingCatalog,
  getPricingCatalog,
} = require('../out/model/pricing.js');

/** Beijing wall-clock time → epoch ms. */
const beijing = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

const BAILIAN_FLASH = 'deepseek-v4.1-flash';
const OFFICIAL_FLASH = 'deepseek-flash';
const ONE_M_INPUT = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };

// ── Bailian: every day 08:00–22:00 ────────────────────────────

test('Bailian peak window is 08:00-22:00 every day', () => {
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 7, 59)), true, '07:59 is off-peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 8, 0)), false, '08:00 is peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 12, 0)), false, 'noon is still peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 21, 59)), false, '21:59 is peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 22, 0)), true, '22:00 is off-peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 21, 3, 0)), true, 'night is off-peak');
});

test('Bailian treats weekends and holidays with the same daily window', () => {
  assert.equal(isBailianOffPeak(beijing(2026, 10, 24, 10, 0)), false, 'Saturday 10:00 is peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 24, 23, 0)), true, 'Saturday 23:00 is off-peak');
  assert.equal(isBailianOffPeak(beijing(2026, 10, 1, 10, 0)), false, 'National Day 10:00 is still peak');
  assert.equal(isBailianOffPeak(beijing(2026, 2, 17, 15, 0)), false, 'Spring Festival 15:00 is still peak');
});

test('Bailian cost follows its own peak window', () => {
  const day = calculateCostDetail(BAILIAN_FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 10, 0));
  const night = calculateCostDetail(BAILIAN_FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 23, 0));
  const saturday = calculateCostDetail(BAILIAN_FLASH, ONE_M_INPUT, beijing(2026, 10, 24, 15, 0));
  assert.equal(day.amount, 2.0, '1M cache-miss tokens at Bailian peak cost 2 CNY');
  assert.equal(night.amount, 1.0, 'Bailian off-peak is half price');
  assert.equal(saturday.amount, 2.0, 'Bailian Saturday afternoon is peak, not off-peak');
});

// ── DeepSeek official: weekdays 09:00–12:00 / 14:00–18:00 ────

test('official weekday peak windows are 09:00-12:00 and 14:00-18:00', () => {
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 9, 0)), false, '09:00 Wednesday is peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 11, 59)), false, '11:59 is peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 12, 0)), true, 'noon break is off-peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 14, 0)), false, '14:00 is peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 17, 59)), false, '17:59 is peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 18, 0)), true, '18:00 is off-peak');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 21, 3, 0)), true, 'night is off-peak');
});

test('official weekends are off-peak all day', () => {
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 24, 10, 0)), true, 'Saturday');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 25, 15, 0)), true, 'Sunday');
});

test('official Chinese statutory holidays are off-peak even on a weekday', () => {
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 1, 10, 0)), true, 'National Day Thursday');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 7, 15, 0)), true, 'last day of National Day');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 2, 17, 10, 0)), true, 'Spring Festival');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 5, 4, 9, 30)), true, 'Labour Day Monday');
  assert.equal(isDeepSeekOffPeak(beijing(2025, 10, 6, 10, 0)), true, '2025 National Day Monday');
  assert.equal(isDeepSeekOffPeak(beijing(2024, 2, 12, 10, 0)), true, '2024 Spring Festival Monday');
  assert.equal(isDeepSeekOffPeak(beijing(2026, 10, 8, 10, 0)), false, 'day after the break is peak again');
});

test('unknown timestamps are treated as peak (the conservative price)', () => {
  assert.equal(isBailianOffPeak(0), false);
  assert.equal(isBailianOffPeak(NaN), false);
  assert.equal(isDeepSeekOffPeak(0), false);
  assert.equal(isDeepSeekOffPeak(NaN), false);
});

test('official cost follows the official peak window', () => {
  const peak = calculateCostDetail(OFFICIAL_FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 10, 0));
  const night = calculateCostDetail(OFFICIAL_FLASH, ONE_M_INPUT, beijing(2026, 10, 21, 20, 0));
  const weekend = calculateCostDetail(OFFICIAL_FLASH, ONE_M_INPUT, beijing(2026, 10, 24, 10, 0));
  assert.equal(peak.amount, 2.0);
  assert.equal(night.amount, 1.0, 'official 20:00 is off-peak');
  assert.equal(weekend.amount, 1.0, 'official Saturday is off-peak');
});

test('the two channels resolve to different providers and rules', () => {
  // Bare v4-pro is the official API; Bailian's deployment is the dated snapshot.
  const official = calculateCostDetail('deepseek-v4-pro', ONE_M_INPUT, beijing(2026, 10, 24, 10, 0));
  const bailian = calculateCostDetail('deepseek-v4-pro-0813', ONE_M_INPUT, beijing(2026, 10, 24, 10, 0));
  assert.equal(official.providerName, 'DeepSeek');
  assert.equal(official.amount, 4.5, 'official Saturday 10:00 is off-peak');
  assert.equal(bailian.providerName, 'Aliyun Bailian');
  assert.equal(bailian.amount, 9.0, 'Bailian Saturday 10:00 is peak');

  // The flash family shows the same split.
  const bailianFlash = calculateCostDetail(BAILIAN_FLASH, ONE_M_INPUT, beijing(2026, 10, 24, 10, 0));
  assert.equal(bailianFlash.amount, 2.0);
  const officialFlash = calculateCostDetail(OFFICIAL_FLASH, ONE_M_INPUT, beijing(2026, 10, 24, 10, 0));
  assert.equal(officialFlash.amount, 1.0);
});

test('models without an off-peak table keep one price around the clock', () => {
  const peak = calculateCostDetail('qwen3.5-plus', ONE_M_INPUT, beijing(2026, 10, 21, 10, 0));
  const off = calculateCostDetail('qwen3.5-plus', ONE_M_INPUT, beijing(2026, 10, 21, 23, 0));
  assert.equal(peak.amount, 0.8);
  assert.equal(off.amount, 0.8, 'Qwen is not a DeepSeek model and has no peak/off-peak pricing');
});

test('the remote catalog can extend the official holiday table without a release', () => {
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