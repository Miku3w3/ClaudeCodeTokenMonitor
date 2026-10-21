/**
 * CostCalculator — re-export wrapper for backward compatibility.
 * All pricing logic now lives in pricing.ts (multi-provider + currency support).
 */
export {
  normalizeModelName,
  calculateCost,
  calculateCostDetail,
  formatCost,
  abbreviateTokens,
  resolvePricing,
  convertCurrency,
  setCustomProviders,
  setPricingCatalog,
  getPricingCatalog,
  isBailianOffPeak,
} from './pricing';
