const DEFAULT_BASE_URL = 'https://www.sportybet.com';
const DEFAULT_MARKETS = '1,18,10,29,11,26,36,14,60100';

function providerError(message, code = 'SPORTYBET_UPSTREAM_ERROR', status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeEvent(event, tournament) {
  if (!event || typeof event.eventId !== 'string' || !event.eventId.startsWith('sr:match:')) return null;
  const start = Number(event.estimateStartTime);
  return {
    eventId: event.eventId,
    tournament: String(tournament?.name || ''),
    category: String(tournament?.categoryName || ''),
    homeTeam: String(event.homeTeamName || ''),
    awayTeam: String(event.awayTeamName || ''),
    startTime: Number.isFinite(start) && start > 0 ? new Date(start).toISOString() : null,
    matchStatus: String(event.matchStatus || 'unknown'),
    markets: Array.isArray(event.markets) ? event.markets.map((market) => ({
      marketId: String(market.id ?? ''),
      marketName: String(market.desc || ''),
      specifier: market.specifier == null ? '' : String(market.specifier),
      status: String(market.status || 'unknown'),
      outcomes: Array.isArray(market.outcomes) ? market.outcomes.map((outcome) => ({
        outcomeId: String(outcome.id ?? ''),
        name: String(outcome.desc || ''),
        odds: typeof outcome.odds === 'string' || typeof outcome.odds === 'number' ? String(outcome.odds) : null,
        active: outcome.isActive === true
      })) : []
    })) : []
  };
}

export function createSportyBetDataClient({
  baseUrl = process.env.SPORTYBET_API_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  cacheTtlMs = 30000,
  now = () => Date.now()
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const cache = new Map();

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json', 'Current-Country': 'NG' }
      });
      if (!response.ok) throw providerError(`SportyBet returned HTTP ${response.status}.`, 'SPORTYBET_UPSTREAM_HTTP_ERROR');
      let body;
      try { body = await response.json(); } catch { throw providerError('SportyBet returned invalid JSON.'); }
      if (!body || body.bizCode !== 10000 || !body.data) throw providerError('SportyBet response did not indicate success.');
      return body.data;
    } catch (error) {
      if (error?.name === 'AbortError') throw providerError('SportyBet request timed out.', 'SPORTYBET_TIMEOUT', 504);
      if (error?.code) throw error;
      throw providerError('Could not reach SportyBet. Try again later.', 'SPORTYBET_NETWORK_ERROR', 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getFixtures({ limit = 30, timeline = 168 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 30));
    const safeTimeline = Math.max(1, Math.min(720, Number.parseInt(timeline, 10) || 168));
    const key = `fixtures:${safeLimit}:${safeTimeline}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return { ...cached.value, cached: true };

    const url = new URL(`/api/ng/factsCenter/pcUpcomingEvents`, baseUrl);
    url.search = new URLSearchParams({
      sportId: 'sr:sport:1', marketId: DEFAULT_MARKETS, pageSize: String(safeLimit),
      pageNum: '1', todayGames: 'false', timeline: String(safeTimeline), _t: String(now())
    }).toString();
    const data = await fetchJson(url);
    if (!Array.isArray(data.tournaments)) throw providerError('SportyBet fixture response had an unexpected shape.');
    const fixtures = data.tournaments.flatMap((tournament) =>
      (Array.isArray(tournament?.events) ? tournament.events : [])
        .map((event) => normalizeEvent(event, tournament)).filter(Boolean)
    ).slice(0, safeLimit);
    const result = {
      provider: 'SportyBet', region: 'NG', fetchedAt: new Date(now()).toISOString(),
      total: Number.isFinite(Number(data.totalNum)) ? Number(data.totalNum) : fixtures.length,
      fixtures, cached: false,
      notice: 'Unofficial public web API. Odds can change at any time. No wager was placed.'
    };
    cache.set(key, { value: result, expiresAt: now() + cacheTtlMs });
    return result;
  }

  async function getMarkets(eventId) {
    if (typeof eventId !== 'string' || !/^sr:match:\d+$/.test(eventId)) {
      throw providerError('Invalid SportyBet event ID.', 'INVALID_EVENT_ID', 400);
    }
    const result = await getFixtures({ limit: 100, timeline: 720 });
    const fixture = result.fixtures.find((item) => item.eventId === eventId);
    if (!fixture) throw providerError('Event was not found in the current upcoming fixtures. It may have started or expired.', 'EVENT_NOT_FOUND', 404);
    return { provider: 'SportyBet', fetchedAt: result.fetchedAt, eventId, markets: fixture.markets, cached: result.cached };
  }

  return Object.freeze({ getFixtures, getMarkets });
}

export const sportyBetDataClient = createSportyBetDataClient();
