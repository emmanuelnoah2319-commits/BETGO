// Odds in a ticket come from one provider's feed. They are only valid for an account at that same bookmaker.
export const ODDS_PROVIDER_PLATFORM = 'SportyBet';

export function oddsSourceBlock({ accountPlatform, hasProviderSelection }) {
  if (hasProviderSelection && accountPlatform !== ODDS_PROVIDER_PLATFORM) {
    return { status: 409, code: 'ODDS_SOURCE_MISMATCH', message: `These odds come from ${ODDS_PROVIDER_PLATFORM}. Choose a ${ODDS_PROVIDER_PLATFORM} account record, or clear the selected outcome.` };
  }
  return null;
}

// Prematch odds must match exactly. In-play odds move every few seconds, so a live selection is also accepted when the
// current odds are higher than the ones the member saw (never lower). The stake cap is always recalculated at the verified odds.
export function oddsDriftBlock({ submittedOdds, currentOdds, live }) {
  if (Math.abs(currentOdds - submittedOdds) <= 0.000001) return null;
  if (live === true && currentOdds > submittedOdds) return null;
  return { code: 'ODDS_CHANGED' };
}
