import test from 'node:test';
import assert from 'node:assert/strict';
import { createSportyBetDataClient, isBettableStatus, isLiveStatus } from '../src/integrations/sportybet-data.js';

function response(data, { ok = true, status = 200, bizCode = 10000 } = {}) {
  return { ok, status, json: async () => ({ bizCode, data }) };
}
const sampleData = {
  totalNum: 1,
  tournaments: [{ id: 'sr:tournament:1', name: 'Test League', categoryName: 'England', events: [{
    eventId: 'sr:match:123456', homeTeamName: 'Home FC', awayTeamName: 'Away FC',
    estimateStartTime: 1790000000000, matchStatus: 'not_started',
    markets: [{ id: 1, desc: '1X2', status: 'active', outcomes: [
      { id: 1, desc: 'Home', odds: '1.90', isActive: true },
      { id: 2, desc: 'Draw', odds: '3.20', isActive: true },
      { id: 3, desc: 'Away', odds: '4.10', isActive: true }
    ] }]
  }] }]
};

test('SportyBet adapter normalizes real-shaped fixture and odds payloads', async () => {
  let requested;
  const client = createSportyBetDataClient({
    baseUrl: 'https://www.sportybet.com', now: () => 1780000000000,
    fetchImpl: async (url, options) => { requested = { url: String(url), options }; return response(sampleData); }
  });
  const result = await client.getFixtures({ limit: 8, timeline: 48 });
  assert.equal(result.provider, 'SportyBet');
  assert.equal(result.fixtures.length, 1);
  assert.equal(result.fixtures[0].homeTeam, 'Home FC');
  assert.equal(result.fixtures[0].markets[0].outcomes[0].odds, '1.90');
  assert.equal(result.fixtures[0].markets[0].outcomes[0].active, true);
  assert.match(requested.url, /pcUpcomingEvents/);
  assert.match(requested.url, /timeline=48/);
  assert.equal(requested.options.headers['Current-Country'], 'NG');
  assert.match(result.notice, /No wager was placed/);
});

test('SportyBet adapter caches fixture responses within its short TTL', async () => {
  let calls = 0; let time = 1000;
  const client = createSportyBetDataClient({
    now: () => time, cacheTtlMs: 500,
    fetchImpl: async () => { calls += 1; return response(sampleData); }
  });
  assert.equal((await client.getFixtures()).cached, false);
  assert.equal((await client.getFixtures()).cached, true);
  assert.equal(calls, 1);
  time += 501;
  assert.equal((await client.getFixtures()).cached, false);
  assert.equal(calls, 2);
});

test('SportyBet adapter rejects malformed event IDs before network access', async () => {
  let calls = 0;
  const client = createSportyBetDataClient({ fetchImpl: async () => { calls += 1; return response(sampleData); } });
  await assert.rejects(client.getMarkets('javascript:alert(1)'), { code: 'INVALID_EVENT_ID', status: 400 });
  assert.equal(calls, 0);
});

test('SportyBet adapter fails closed for upstream errors and invalid payloads', async () => {
  const badHttp = createSportyBetDataClient({ fetchImpl: async () => response({}, { ok: false, status: 503 }) });
  await assert.rejects(badHttp.getFixtures(), { code: 'SPORTYBET_UPSTREAM_HTTP_ERROR', status: 502 });
  const badBiz = createSportyBetDataClient({ fetchImpl: async () => response(sampleData, { bizCode: 9000 }) });
  await assert.rejects(badBiz.getFixtures(), { code: 'SPORTYBET_UPSTREAM_ERROR', status: 502 });
});

test('SportyBet adapter enforces provider query bounds', async () => {
  let requestedUrl = '';
  const client = createSportyBetDataClient({ fetchImpl: async (url) => { requestedUrl = String(url); return response(sampleData); } });
  await client.getFixtures({ limit: 999, timeline: 9999 });
  assert.match(requestedUrl, /pageSize=100/);
  assert.match(requestedUrl, /timeline=720/);
});


test('the dashboard ships the betting workspace and nothing that auto-loads games', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="game-search-form"/);
  assert.match(html, /id="ticket-max-profit"/);
  assert.match(source, /\/api\/sportybet\/search\?q=/);
  // Games are only fetched in response to a typed search, never as a preloaded fixture list.
  assert.doesNotMatch(source, /\/api\/sportybet\/fixtures/);
});

const eventData = (overrides = {}) => ({
  eventId: 'sr:match:123456', homeTeamName: 'Home FC', awayTeamName: 'Away FC', estimateStartTime: 1790000000000, matchStatus: 'not_started',
  sport: { category: { name: 'England', tournament: { name: 'Test League' } } },
  markets: [
    { id: 1, desc: '1X2', status: 'active', outcomes: [{ id: 1, desc: 'Home', odds: '1.90', isActive: true }, { id: 2, desc: 'Draw', odds: '3.20', isActive: true }, { id: 3, desc: 'Away', odds: '4.10', isActive: true }] },
    { id: 18, desc: 'Over/Under', specifier: 'total=2.5', status: 'active', outcomes: [{ id: 12, desc: 'Over', odds: '1.85', isActive: true }, { id: 13, desc: 'Under', odds: '1.95', isActive: true }] },
    { id: 18, desc: 'Over/Under', specifier: 'total=3.5', status: 'active', outcomes: [{ id: 12, desc: 'Over', odds: '2.80', isActive: true }, { id: 13, desc: 'Under', odds: '1.40', isActive: true }] },
    { id: 777, desc: 'Correct Score', status: 'active', outcomes: [{ id: 1, desc: '1:0', odds: '8.00', isActive: true }] }
  ],
  ...overrides
});
const routed = (handlers) => async (url) => {
  const path = new URL(String(url)).pathname;
  for (const [fragment, reply] of Object.entries(handlers)) if (path.includes(fragment)) return typeof reply === 'function' ? reply(url) : reply;
  throw new Error(`unexpected request ${url}`);
};

test('getEventMarkets returns every market from the per-event endpoint, keeping lines that share a market id apart', async () => {
  const requested = [];
  const client = createSportyBetDataClient({ now: () => 1780000000000, fetchImpl: routed({ '/factsCenter/event': (url) => { requested.push(String(url)); return response(eventData()); } }) });
  const result = await client.getEventMarkets('sr:match:123456');
  assert.equal(result.complete, true);
  assert.equal(result.label, 'Home FC vs Away FC');
  assert.equal(result.tournament, 'Test League');
  assert.equal(result.markets.length, 4);
  const lines = result.markets.filter((market) => market.marketId === '18').map((market) => market.specifier);
  assert.deepEqual(lines, ['total=2.5', 'total=3.5']);
  assert.match(requested[0], /eventId=sr%3Amatch%3A123456/);
});

test('getEventMarkets falls back to the fixture list and says the market list is incomplete', async () => {
  const client = createSportyBetDataClient({ fetchImpl: routed({ '/factsCenter/event': response({}, { ok: false, status: 404 }), pcUpcomingEvents: response(sampleData) }) });
  const result = await client.getEventMarkets('sr:match:123456');
  assert.equal(result.complete, false);
  assert.equal(result.markets.length, 1);
  await assert.rejects(client.getEventMarkets('sr:match:999'), { code: 'EVENT_NOT_FOUND', status: 404 });
  await assert.rejects(client.getEventMarkets('bad id'), { code: 'INVALID_EVENT_ID', status: 400 });
});

test('getMarketsForEvents always fetches fresh odds per event and omits games that no longer exist', async () => {
  let eventCalls = 0;
  const client = createSportyBetDataClient({ fetchImpl: routed({
    '/factsCenter/event': (url) => { eventCalls += 1; return String(url).includes('123456') ? response(eventData()) : response({}, { ok: false, status: 404 }); },
    pcUpcomingEvents: response(sampleData)
  }) });
  const result = await client.getMarketsForEvents(['sr:match:123456', 'sr:match:999', 'sr:match:123456']);
  assert.equal(eventCalls, 2);
  assert.equal(result.events['sr:match:123456'].label, 'Home FC vs Away FC');
  assert.equal(result.events['sr:match:123456'].markets.length, 4);
  assert.equal(result.events['sr:match:999'], undefined);
  await assert.rejects(client.getMarketsForEvents(['nope']), { code: 'INVALID_EVENT_ID', status: 400 });
  await assert.rejects(client.getMarketsForEvents([]), { code: 'INVALID_EVENT_ID' });
});

const searchPage = () => ({
  totalNum: 4,
  tournaments: [{ name: 'Premier League', categoryName: 'England', events: [
    { eventId: 'sr:match:1', homeTeamName: 'Arsenal FC', awayTeamName: 'Chelsea FC', estimateStartTime: 1790000000000, matchStatus: 'not_started', markets: [] },
    { eventId: 'sr:match:2', homeTeamName: 'Liverpool', awayTeamName: 'Arsenal FC', estimateStartTime: 1789000000000, matchStatus: 'not_started', markets: [{ id: 1, desc: '1X2', status: 'active', outcomes: [] }] },
    { eventId: 'sr:match:3', homeTeamName: 'Arsenal FC', awayTeamName: 'Spurs', estimateStartTime: 1780000000000, matchStatus: 'live', markets: [] },
    { eventId: 'sr:match:4', homeTeamName: 'Atlético Madrid', awayTeamName: 'Sevilla', estimateStartTime: 1791000000000, matchStatus: 'not_started', markets: [] }
  ] }]
});

test('searchFixtures returns only upcoming games matching what was typed, without their odds', async () => {
  const client = createSportyBetDataClient({ fetchImpl: routed({ pcUpcomingEvents: response(searchPage()) }) });
  const both = await client.searchFixtures('Arsenal vs Chelsea');
  assert.deepEqual(both.fixtures.map((fixture) => fixture.eventId), ['sr:match:1']);
  assert.equal(both.fixtures[0].markets, undefined);
  const one = await client.searchFixtures('arsenal');
  assert.deepEqual(one.fixtures.map((fixture) => fixture.eventId), ['sr:match:2', 'sr:match:1'], 'sorted by kick-off; the live game is excluded');
  assert.equal(one.fixtures[0].marketCount, 1);
  const accent = await client.searchFixtures('atletico');
  assert.deepEqual(accent.fixtures.map((fixture) => fixture.eventId), ['sr:match:4']);
  assert.deepEqual((await client.searchFixtures('no such team')).fixtures, []);
});

test('searchFixtures rejects empty or oversized queries before any network call', async () => {
  let calls = 0;
  const client = createSportyBetDataClient({ fetchImpl: async () => { calls += 1; return response(searchPage()); } });
  for (const bad of ['', ' a ', 'x'.repeat(61), 'vs']) await assert.rejects(client.searchFixtures(bad), { code: 'INVALID_SEARCH', status: 400 });
  assert.equal(calls, 0);
});

const livePage = () => ({
  tournaments: [{ name: 'Premier League', categoryName: 'England', events: [
    { eventId: 'sr:match:3', homeTeamName: 'Arsenal FC', awayTeamName: 'Spurs', estimateStartTime: 1780000000000, matchStatus: '2nd half', setScore: '2:1', playedSeconds: '67:12', markets: [] },
    { eventId: 'sr:match:9', homeTeamName: 'Old Boys', awayTeamName: 'Finished FC', estimateStartTime: 1780000000000, matchStatus: 'ended', markets: [] }
  ] }]
});

test('status helpers: upcoming and in-play games are bettable, finished ones are not', () => {
  for (const status of ['1st half', 'halftime', '2nd half', 'live']) { assert.equal(isLiveStatus(status), true, status); assert.equal(isBettableStatus(status), true, status); }
  assert.equal(isBettableStatus('not_started'), true);
  assert.equal(isLiveStatus('not_started'), false);
  for (const status of ['ended', 'closed', 'cancelled', 'abandoned', 'postponed', 'unknown', '', undefined]) assert.equal(isBettableStatus(status), false, String(status));
});

test('searchFixtures puts live games first with score and clock, and drops finished games', async () => {
  const client = createSportyBetDataClient({ fetchImpl: routed({ liveOrPrematchEvents: response(livePage()), pcUpcomingEvents: response(searchPage()) }) });
  const result = await client.searchFixtures('arsenal');
  assert.equal(result.liveAvailable, true);
  assert.deepEqual(result.fixtures.map((fixture) => fixture.eventId), ['sr:match:3', 'sr:match:2', 'sr:match:1']);
  assert.equal(result.fixtures[0].isLive, true);
  assert.equal(result.fixtures[0].score, '2 - 1');
  assert.equal(result.fixtures[0].clock, '67:12');
  assert.equal(result.fixtures[1].isLive, false);
  assert.deepEqual((await client.searchFixtures('finished')).fixtures, []);
});

test('if the live feed is unreachable, search still returns upcoming games and reports liveAvailable false', async () => {
  const client = createSportyBetDataClient({ fetchImpl: routed({ liveOrPrematchEvents: response({}, { ok: false, status: 500 }), pcUpcomingEvents: response(searchPage()) }) });
  const result = await client.searchFixtures('chelsea');
  assert.equal(result.liveAvailable, false);
  assert.deepEqual(result.fixtures.map((fixture) => fixture.eventId), ['sr:match:1']);
});

test('getEventMarkets marks an in-play game and carries its score', async () => {
  const client = createSportyBetDataClient({ fetchImpl: routed({ '/factsCenter/event': response(eventData({ matchStatus: '1st half', setScore: '0:0', playedSeconds: '12:03' })) }) });
  const result = await client.getEventMarkets('sr:match:123456');
  assert.equal(result.isLive, true);
  assert.equal(result.score, '0 - 0');
  const verified = await client.getMarketsForEvents(['sr:match:123456']);
  assert.equal(verified.events['sr:match:123456'].isLive, true);
});

test('the live list is cached only briefly so in-play odds stay fresh', async () => {
  let calls = 0; let time = 1000;
  const client = createSportyBetDataClient({ now: () => time, cacheTtlMs: 30000, fetchImpl: routed({ liveOrPrematchEvents: () => { calls += 1; return response(livePage()); } }) });
  await client.getLiveFixtures(); await client.getLiveFixtures();
  assert.equal(calls, 1);
  time += 5001; await client.getLiveFixtures();
  assert.equal(calls, 2);
});

test('searchFixtures reads past the first page so a team further down SportyBet\'s list is still found', async () => {
  const requestedPages = [];
  const pageOf = (n) => ({ totalNum: 250, tournaments: [{ name: 'Serie A', categoryName: 'Italy', events: Array.from({ length: n === 3 ? 50 : 100 }, (_, i) => ({
    eventId: `sr:match:${n * 1000 + i}`, homeTeamName: n === 3 && i === 7 ? 'Atalanta BC' : `Team ${n}-${i}`, awayTeamName: `Rival ${n}-${i}`, estimateStartTime: 1790000000000 + i, matchStatus: 'not_started', markets: [] })) }] });
  const client = createSportyBetDataClient({ fetchImpl: routed({
    liveOrPrematchEvents: response({ tournaments: [] }),
    pcUpcomingEvents: (url) => { const n = Number(new URL(String(url)).searchParams.get('pageNum')); requestedPages.push(n); return response(pageOf(n)); }
  }) });
  const result = await client.searchFixtures('atalanta');
  assert.deepEqual(result.fixtures.map((fixture) => fixture.homeTeam), ['Atalanta BC']);
  assert.equal(result.scanned, 250);
  assert.deepEqual([...requestedPages].sort(), [1, 2, 3]);
});
