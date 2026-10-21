/**
 * Configuration reader for Claude Code Token Monitor v1.0.0.
 * Reads from VSCode workspace configuration (no caching — getConfiguration is fast).
 */
import * as vscode from 'vscode';
import type { ExtensionConfig, Currency, CustomModelConfig } from '../model/types';
import { resolveLanguage } from '../i18n';
import { resolveCurrency } from '../model/pricing';
import { setCustomRates, setBailianPeakPricingEnabled } from '../model/pricing';

/** Read the full typed configuration snapshot. */
export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('claudeTokenMonitor');

  const langSetting     = cfg.get<string>('language', 'auto');
  const currencySetting = cfg.get<string>('currency', 'auto');
  const resolvedLang    = resolveLanguage(langSetting);
  const resolvedCurr    = resolveCurrency(currencySetting, resolvedLang);

  const rawRates = cfg.get<Record<string, number>>('exchangeRates', {}) || {};
  // Only override the fetched rates when the user actually configured some.
  // Passing {} here used to wipe the daily-updated rates on every config read.
  if (Object.keys(rawRates).length > 0) {
    setCustomRates(rawRates);
  }

  // Applies to every cost calculation from now on (including history replay).
  setBailianPeakPricingEnabled(cfg.get<boolean>('pricing.bailianPeak', true));

  return {
    language: langSetting,
    resolvedLanguage: resolvedLang,
    currency: currencySetting,
    resolvedCurrency: resolvedCurr as Currency,

    exchangeRates: rawRates,
    customModels: (cfg.get<any[]>('customModels') || []) as CustomModelConfig[],

    showModelName:    cfg.get<boolean>('statusBar.showModelName', false),
    compactMode:      cfg.get<boolean>('statusBar.compactMode', false),

    budgetWarning: cfg.get<number>('budgetWarning', 0),
    pollIntervalMs: cfg.get<number>('pollIntervalMs', 2000),
    pricingUpdateUrl: cfg.get<string>('pricing.updateUrl', ''),
    bailianPeakPricing: cfg.get<boolean>('pricing.bailianPeak', true),
  };
}
