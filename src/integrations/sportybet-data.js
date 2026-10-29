const DEFAULT_BASE_URL = 'https://www.sportybet.com';
const DEFAULT_MARKETS = '1,18,10,29,11,26,36,14,60100';

const NOT_LIVE_STATUSES = new Set(['', 'unknown', 'not_started', 'ended', 'closed', 'cancelled', 'canceled', 'abandoned', 'postponed', 'walkover']);
// A game is live when the provider reports any in-play status (1st half, halftime, 2nd half, ...).
export function isLiveStatus(status) { return !NOT_LIVE_STATUSES.has(String(status ?? '').trim().toLowerCase()); }
// Only upcoming and in-play games can take a bet. Finished, cancelled or unknown games cannot.
export function isBettableStatus(status) { return String(status ?? '') === 'not_started' || isLiveStatus(status); }

function providerError(message, code = 'SPORTYBET_UPSTREAM_ERROR', status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function liveScore(event) {
  if (event?.setScore != null && String(event.setScore).trim()) return String(event.setScore).trim().replace(':', ' - ');
  const home = event?.homeTeamScore ?? event?.homeScore; const away = event?.awayTeamScore ?? event?.awayScore;
  return home != null && away != null ? `${home} - ${away}` : '';
}

function normalizeEvent(event, tournament) {
  if (!event || typeof event.eventId !== 'string' || !event.eventId.startsWith('sr:match:')) return null;
  if (!tournament && event.sport?.category) tournament = { name: event.sport.category.tournament?.name, categoryName: event.sport.category.name };
  const start = Number(event.estimateStartTime);
  return {
    eventId: event.eventId,
    tournament: String(tournament?.name || ''),
    category: String(tournament?.categoryName || ''),
    homeTeam: String(event.homeTeamName || ''),
    awayTeam: String(event.awayTeamName || ''),
    startTime: Number.isFinite(start) && start > 0 ? new Date(start).toISOString() : null,
    matchStatus: String(event.matchStatus || 'unknown'),
    isLive: isLiveStatus(event.matchStatus),
    score: liveScore(event),
    clock: event.playedSeconds == null ? '' : String(event.playedSeconds),
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

// Lower-cases, strips accents and punctuation so "Atlético" matches "atletico" and "Man. City" matches "man city".
export function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Words that people type between team names; ignoring them lets "Arsenal vs Chelsea" match.
const SEARCH_FILLER = new Set(['vs', 'v', 'versus', 'fc', 'cf']);

export function searchTokens(query) {
  return normalizeSearchText(query).split(' ').filter((token) => token && !SEARCH_FILLER.has(token));
}

export function fixtureMatches(fixture, tokens) {
  const haystack = normalizeSearchText(`${fixture.homeTeam} ${fixture.awayTeam} ${fixture.tournament} ${fixture.category}`);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 60;
const SEARCH_MAX_PAGES = 25;
const SEARCH_CHUNK = 5;
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_RESULTS = 20;
const LIVE_CACHE_TTL_MS = 5000;

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

  async function getFixtures({ limit = 30, timeline = 168, forceRefresh = false, pageNum = 1 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 30));
    const safeTimeline = Math.max(1, Math.min(720, Number.parseInt(timeline, 10) || 168));
    const safePage = Math.max(1, Math.min(10, Number.parseInt(pageNum, 10) || 1));
    const key = `fixtures:${safeLimit}:${safeTimeline}:${safePage}`;
    const cached = cache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > now()) return { ...cached.value, cached: true };

    const url = new URL(`/api/ng/factsCenter/pcUpcomingEvents`, baseUrl);
    url.search = new URLSearchParams({
      sportId: 'sr:sport:1', marketId: DEFAULT_MARKETS, pageSize: String(safeLimit),
      pageNum: String(safePage), todayGames: 'false', timeline: String(safeTimeline), _t: String(now())
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

  // In-play games. The endpoint is unofficial; if it cannot be read, callers get an error and decide how to degrade.
  async function getLiveFixtures({ forceRefresh = false } = {}) {
    const key = 'live';
    const cached = cache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > now()) return { ...cached.value, cached: true };
    const url = new URL('/api/ng/factsCenter/liveOrPrematchEvents', baseUrl);
    url.search = new URLSearchParams({ sportId: 'sr:sport:1', _t: String(now()) }).toString();
    const data = await fetchJson(url);
    const tournaments = Array.isArray(data) ? data : data.tournaments;
    if (!Array.isArray(tournaments)) throw providerError('SportyBet live response had an unexpected shape.');
    const fixtures = tournaments.flatMap((tournament) =>
      (Array.isArray(tournament?.events) ? tournament.events : []).map((event) => normalizeEvent(event, tournament)).filter(Boolean)
    ).filter((fixture) => fixture.isLive);
    const result = { provider: 'SportyBet', region: 'NG', fetchedAt: new Date(now()).toISOString(), fixtures, cached: false };
    cache.set(key, { value: result, expiresAt: now() + Math.min(cacheTtlMs, LIVE_CACHE_TTL_MS) });
    return result;
  }

  const EVENT_ID_PATTERN = /^sr:match:\d+$/;

  // SportyBet lists thousands of matches a month, so one page is never enough. Read page 1, use its total to decide how many
  // more pages exist (capped), and fetch them a few at a time. Pages are cached briefly, so repeat searches are cheap.
  async function loadSearchPages() {
    const first = await getFixtures({ limit: SEARCH_PAGE_SIZE, timeline: 720, pageNum: 1 });
    const pages = [first];
    pages.diag = { upstreamTotal: first.total, firstPage: first.fixtures.length, failedPages: 0 };
    const total = Number(first.total);
    const lastPage = Number.isFinite(total) && total > first.fixtures.length
      ? Math.min(SEARCH_MAX_PAGES, Math.ceil(total / SEARCH_PAGE_SIZE))
      : (first.fixtures.length >= SEARCH_PAGE_SIZE ? SEARCH_MAX_PAGES : 1);
    for (let start = 2; start <= lastPage; start += SEARCH_CHUNK) {
      const numbers = Array.from({ length: Math.min(SEARCH_CHUNK, lastPage - start + 1) }, (_, index) => start + index);
      const batch = await Promise.all(numbers.map((pageNum) => getFixtures({ limit: SEARCH_PAGE_SIZE, timeline: 720, pageNum }).catch(() => null)));
      pages.diag.failedPages += batch.filter((page) => !page).length;
      pages.push(...batch.filter(Boolean));
      if (batch.some((page) => page && page.fixtures.length === 0)) break; // ran past the last page
    }
    return pages;
  }

  // Search only runs when the user types a game. Nothing is listed up front, and only matches that have not started are returned.
  async function searchFixtures(query) {
    const text = String(query ?? '').trim();
    if (text.length < SEARCH_MIN_LENGTH || text.length > SEARCH_MAX_LENGTH) {
      throw providerError(`Type ${SEARCH_MIN_LENGTH}–${SEARCH_MAX_LENGTH} characters of the game, for example "Arsenal vs Chelsea".`, 'INVALID_SEARCH', 400);
    }
    const tokens = searchTokens(text);
    if (!tokens.length) throw providerError('Type a team or competition name to search.', 'INVALID_SEARCH', 400);
    const [live, pages] = await Promise.all([getLiveFixtures().catch(() => null), loadSearchPages()]);
    const seen = new Set();
    const matches = [];
    const consider = (fixture) => {
      if (seen.has(fixture.eventId)) return;
      seen.add(fixture.eventId);
      if (!isBettableStatus(fixture.matchStatus) || !fixtureMatches(fixture, tokens)) return;
      const { markets, ...summary } = fixture;
      matches.push({ ...summary, marketCount: markets.length });
    };
    // The live feed goes first so an in-play game is never shown from a stale upcoming listing.
    for (const fixture of live?.fixtures || []) consider(fixture);
    for (const page of pages) for (const fixture of page?.fixtures || []) if (fixture.matchStatus === 'not_started') consider(fixture);
    const scanned = seen.size;
    matches.sort((a, b) => (Number(b.isLive) - Number(a.isLive)) || String(a.startTime).localeCompare(String(b.startTime)));
    return {
      provider: 'SportyBet', query: text, fetchedAt: new Date(now()).toISOString(), fixtures: matches.slice(0, SEARCH_MAX_RESULTS),
      truncated: matches.length > SEARCH_MAX_RESULTS, liveAvailable: live !== null, scanned, diag: { ...pages.diag, pagesLoaded: pages.length, live: live ? live.fixtures.length : null },
      notice: 'Unofficial public web API. Odds can change at any time. No wager was placed.'
    };
  }

  // Full market list for one game. If the per-event endpoint is unavailable we fall back to the fixture list, which only
  // carries a handful of core markets; the result says so (complete: false) so the UI never implies it is showing everything.
  async function getEventMarkets(eventId, { forceRefresh = true } = {}) {
    if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) {
      throw providerError('Invalid SportyBet event ID.', 'INVALID_EVENT_ID', 400);
    }
    const key = `event:${eventId}`;
    const cached = cache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > now()) return { ...cached.value, cached: true };
    let result = null;
    try {
      const url = new URL('/api/ng/factsCenter/event', baseUrl);
      url.search = new URLSearchParams({ eventId, productId: '3', _t: String(now()) }).toString();
      const data = await fetchJson(url);
      const event = normalizeEvent(data?.eventId ? data : data?.event, null);
      if (event && event.eventId === eventId && event.markets.length) {
        result = { provider: 'SportyBet', fetchedAt: new Date(now()).toISOString(), eventId, label: `${event.homeTeam} vs ${event.awayTeam}`, homeTeam: event.homeTeam, awayTeam: event.awayTeam, tournament: event.tournament, startTime: event.startTime, matchStatus: event.matchStatus, isLive: event.isLive, score: event.score, clock: event.clock, markets: event.markets, complete: true, cached: false };
      }
    } catch (error) {
      if (error?.code === 'SPORTYBET_TIMEOUT') throw error;
    }
    if (!result) {
      const liveList = await getLiveFixtures({ forceRefresh: true }).catch(() => ({ fixtures: [], fetchedAt: new Date(now()).toISOString() }));
      let fixture = liveList.fixtures.find((item) => item.eventId === eventId);
      let fetchedAt = liveList.fetchedAt;
      if (!fixture) {
        const list = await getFixtures({ limit: 100, timeline: 720, forceRefresh: true });
        fixture = list.fixtures.find((item) => item.eventId === eventId);
        fetchedAt = list.fetchedAt;
      }
      if (!fixture) throw providerError('Event was not found in the current fixtures. It may have finished or expired.', 'EVENT_NOT_FOUND', 404);
      result = { provider: 'SportyBet', fetchedAt, eventId, label: `${fixture.homeTeam} vs ${fixture.awayTeam}`, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam, tournament: fixture.tournament, startTime: fixture.startTime, matchStatus: fixture.matchStatus, isLive: fixture.isLive, score: fixture.score, clock: fixture.clock, markets: fixture.markets, complete: false, cached: false };
    }
    cache.set(key, { value: result, expiresAt: now() + cacheTtlMs });
    return result;
  }

  async function getMarkets(eventId) {
    return getEventMarkets(eventId);
  }

  // Fresh markets for every leg of a slip (always bypasses the cache; verification must see current odds).
  async function getMarketsForEvents(eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 10 || eventIds.some((id) => typeof id !== 'string' || !EVENT_ID_PATTERN.test(id))) {
      throw providerError('Invalid SportyBet event IDs.', 'INVALID_EVENT_ID', 400);
    }
    const unique = [...new Set(eventIds)];
    const settled = await Promise.allSettled(unique.map((id) => getEventMarkets(id, { forceRefresh: true })));
    const events = {};
    let fetchedAt = new Date(now()).toISOString();
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        const { label, startTime, matchStatus, isLive, markets } = outcome.value;
        events[unique[index]] = { label, startTime, matchStatus, isLive: isLive === true, markets };
        fetchedAt = outcome.value.fetchedAt;
      } else if (outcome.reason?.code !== 'EVENT_NOT_FOUND') throw outcome.reason;
    });
    return { provider: 'SportyBet', fetchedAt, events };
  }

  return Object.freeze({ getFixtures, getLiveFixtures, searchFixtures, getEventMarkets, getMarkets, getMarketsForEvents });
}

export const sportyBetDataClient = createSportyBetDataClient();
