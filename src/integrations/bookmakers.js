const PLATFORMS = Object.freeze([
  'SportyBet',
  'Football.com Nigeria'
]);

/**
 * Registry for bookmaker connectors. A platform must not be marked available
 * until its placement interface, permission, authentication and reconciliation
 * behavior have been verified. No fallback to undocumented calls is attempted.
 */
export function listBookmakerIntegrations() {
  return PLATFORMS.map((name) => ({
    name,
    status: 'unavailable',
    capabilities: [],
    betPlacement: false,
    accountAuthentication: false,
    balanceLookup: false,
    betStatusLookup: false,
    automaticBettingEnabled: false,
    reason: 'No verified, permitted third-party bet-placement interface is configured for this bookmaker.'
  }));
}

export function getBookmakerConnector(platform) {
  if (!PLATFORMS.includes(platform)) {
    const error = new Error('Unsupported bookmaker platform.');
    error.code = 'UNSUPPORTED_BOOKMAKER';
    throw error;
  }
  const error = new Error(`Bet placement is unavailable for ${platform}: no verified, permitted connector is configured.`);
  error.code = 'BOOKMAKER_CONNECTOR_UNAVAILABLE';
  error.status = 503;
  throw error;
}

export const supportedBookmakerPlatforms = PLATFORMS;
