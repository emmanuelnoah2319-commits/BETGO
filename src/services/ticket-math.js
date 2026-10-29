import { capStakeToNetProfit } from './profit-cap.js';

export const MAX_LEGS = 10;
export const MIN_ACCUMULATOR_LEGS = 2;
export const MAX_COMBINED_ODDS = 1000;

// Accumulator odds are the product of each leg's decimal odds. Rounded to 4 places only to remove floating-point noise;
// a bookmaker may round its own total differently, so this is an estimate to be checked before any real bet.
export function combinedOdds(oddsList) {
  return Number(oddsList.reduce((product, odds) => product * odds, 1).toFixed(4));
}

export function legsBlock(legs) {
  if (!Array.isArray(legs) || legs.length < MIN_ACCUMULATOR_LEGS) return { code: 'TOO_FEW_LEGS', message: `An accumulator needs at least ${MIN_ACCUMULATOR_LEGS} selections.` };
  if (legs.length > MAX_LEGS) return { code: 'TOO_MANY_LEGS', message: `An accumulator can have at most ${MAX_LEGS} selections.` };
  if (new Set(legs.map((leg) => leg.eventId)).size !== legs.length) return { code: 'DUPLICATE_EVENT', message: 'Use only one outcome per match in an accumulator.' };
  return null;
}

// Stake is a ceiling that the net-profit cap can only lower. Net profit excludes the returned stake.
export function ticketSummary({ oddsList, stakeMinor, maxNetProfitMinor }) {
  const odds = combinedOdds(oddsList);
  if (odds > MAX_COMBINED_ODDS) {
    const error = new Error(`Combined odds of ${odds} exceed the ${MAX_COMBINED_ODDS} limit.`);
    error.code = 'COMBINED_ODDS_TOO_HIGH';
    throw error;
  }
  const effectiveStakeMinor = capStakeToNetProfit(stakeMinor, odds, maxNetProfitMinor);
  return {
    combinedOdds: odds,
    effectiveStakeMinor,
    stakeAdjusted: effectiveStakeMinor < stakeMinor,
    potentialNetProfitMinor: Math.floor(effectiveStakeMinor * (odds - 1)),
    potentialReturnMinor: Math.floor(effectiveStakeMinor * odds)
  };
}
