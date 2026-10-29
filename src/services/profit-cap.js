/**
 * Calculates a stake ceiling in kobo from decimal odds and maximum net profit.
 * Net profit excludes the returned stake: stake * (decimal odds - 1).
 */
export function capStakeToNetProfit(stakeMinor, oddsDecimal, maxNetProfitMinor) {
  if (!Number.isSafeInteger(stakeMinor) || stakeMinor < 100) throw new TypeError('Stake must be an integer amount of at least ₦1 in kobo.');
  if (!Number.isFinite(oddsDecimal) || oddsDecimal <= 1 || oddsDecimal > 1000) throw new TypeError('Decimal odds must be greater than 1 and at most 1000.');
  if (!Number.isSafeInteger(maxNetProfitMinor) || maxNetProfitMinor < 100) throw new TypeError('Maximum net profit must be an integer amount of at least ₦1 in kobo.');
  let capped = Math.min(stakeMinor, Math.floor(maxNetProfitMinor / (oddsDecimal - 1)));
  // Floating-point division can land one kobo high; never let the resulting net profit exceed the cap.
  while (capped > 0 && Math.floor(capped * (oddsDecimal - 1)) > maxNetProfitMinor) capped -= 1;
  return capped;
}
