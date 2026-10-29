// Odds in a ticket come from one provider's feed. They are only valid for an account at that same bookmaker.
export const ODDS_PROVIDER_PLATFORM = 'SportyBet';

export function oddsSourceBlock({ accountPlatform, hasProviderSelection }) {
  if (hasProviderSelection && accountPlatform !== ODDS_PROVIDER_PLATFORM) {
    return { status: 409, code: 'ODDS_SOURCE_MISMATCH', message: `These odds come from ${ODDS_PROVIDER_PLATFORM}. Choose a ${ODDS_PROVIDER_PLATFORM} account record, or clear the selected outcome.` };
  }
  return null;
}
