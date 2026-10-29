const SUPPORTED_PLATFORMS = Object.freeze([
  'SportyBet',
  'Football.com Nigeria'
]);

// BETGO is deliberately scoping account-connection integration work to SportyBet first.
// Other existing bookmaker features (subscriptions and read-only data) remain untouched.
const ACTIVE_INTEGRATION_SCOPE = Object.freeze(['SportyBet']);

/**
 * Registry for bookmaker connectors. A platform must not be marked available
 * until its placement interface, permission, authentication and reconciliation
 * behavior have been verified. No fallback to undocumented calls is attempted.
 */
export function listBookmakerIntegrations() {
  return ACTIVE_INTEGRATION_SCOPE.map((name) => ({
    name,
    status: 'unavailable',
    capabilities: [],
    betPlacement: false,
    accountAuthentication: false,
    balanceLookup: false,
    betStatusLookup: false,
    automaticBettingEnabled: false,
    reason: 'SportyBet account connection and bet placement remain unavailable until a verified, permitted connector is configured.'
  }));
}

export function getBookmakerConnector(platform) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    const error = new Error('Unsupported bookmaker platform.');
    error.code = 'UNSUPPORTED_BOOKMAKER';
    throw error;
  }
  const error = new Error(`Bet placement is unavailable for ${platform}: no verified, permitted connector is configured.`);
  error.code = 'BOOKMAKER_CONNECTOR_UNAVAILABLE';
  error.status = 503;
  throw error;
}

// Keep existing account/subscription routes compatible while exposing only the
// current integration scope in the integrations dashboard.
export const supportedBookmakerPlatforms = SUPPORTED_PLATFORMS;
