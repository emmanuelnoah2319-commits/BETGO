// Pure ticket maths for the browser. Mirrors src/services/ticket-math.js and profit-cap.js; test/ticket-calc.test.js keeps them
// in step. Money is handled as integer kobo. The server recalculates everything, so this only drives the live preview.
export const MAX_LEGS = 10;
export const MAX_COMBINED_ODDS = 1000;
export const MIN_STAKE_MINOR = 100;

export function combinedOdds(oddsList) {
  return Number(oddsList.reduce((product, odds) => product * odds, 1).toFixed(4));
}

// "1,250.50" -> 125050. Returns null for anything that is not a plain naira amount with at most two decimals.
export function nairaToMinor(text) {
  const cleaned = String(text ?? '').replace(/[,\s₦]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

export function minorToNaira(minor) {
  return `₦${(Number(minor) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The entered stake is a ceiling; the profit cap can only lower it. Net profit excludes the returned stake.
export function summarizeTicket({ oddsList, stakeMinor, maxNetProfitMinor }) {
  if (!Array.isArray(oddsList) || !oddsList.length) return { error: 'Pick at least one outcome.' };
  const odds = combinedOdds(oddsList);
  if (!(odds > 1)) return { error: 'Odds must be greater than 1.' };
  if (odds > MAX_COMBINED_ODDS) return { error: `Combined odds of ${odds} exceed the ${MAX_COMBINED_ODDS} limit. Remove a selection.` };
  if (stakeMinor === null || stakeMinor < MIN_STAKE_MINOR) return { error: 'Enter a stake of at least ₦1.00.', combinedOdds: odds };
  if (maxNetProfitMinor === null || maxNetProfitMinor < MIN_STAKE_MINOR) return { error: 'Enter a maximum profit of at least ₦1.00.', combinedOdds: odds };
  let effectiveStakeMinor = Math.min(stakeMinor, Math.floor(maxNetProfitMinor / (odds - 1)));
  while (effectiveStakeMinor > 0 && Math.floor(effectiveStakeMinor * (odds - 1)) > maxNetProfitMinor) effectiveStakeMinor -= 1;
  if (effectiveStakeMinor < MIN_STAKE_MINOR) return { error: 'This maximum profit is too low for a ₦1.00 stake at these odds. Raise it.', combinedOdds: odds };
  return {
    combinedOdds: odds,
    effectiveStakeMinor,
    stakeAdjusted: effectiveStakeMinor < stakeMinor,
    potentialNetProfitMinor: Math.floor(effectiveStakeMinor * (odds - 1)),
    potentialReturnMinor: Math.floor(effectiveStakeMinor * odds)
  };
}
