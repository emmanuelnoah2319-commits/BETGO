import test from 'node:test';
import assert from 'node:assert/strict';
import { createFootballComDataClient, normalizeMatchStatus, parseBookingCodes } from '../src/integrations/footballcom-data.js';
import { isBettableStatus } from '../src/integrations/sportybet-data.js';

const event = (id, overrides = {}) => ({
  eventId: `sr:match:${id}`, estimateStartTime: 1793727900000, matchStatus: 'Not start',
  homeTeamName: 'Barcelona', awayTeamName: 'Aston Villa',
  sport: { id: 'sr:sport:1', category: { name: 'International Clubs', tournament: { name: 'UEFA Champions League' } } },
  markets: [{ id: '1', desc: '1X2', status: 0, outcomes: [{ id: '3', odds: '1.82', isActive: 1, desc: 'Away' }] }],
  ...overrides
});
const payload = { bizCode: 10000, data: [{ shareCode: 'TL7RJZ', foldsAmount: 2, totalOdds: 164441306, deadline: 1794686400000, createTime: 1792621993000, popularity: 4188, eventVOList: [event(74165978), event(74165980)] }] };
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('maps Football.com status text onto the shared status helpers', () => {
  assert.equal(normalizeMatchStatus('Not start'), 'not_started');
  assert.equal(isBettableStatus(normalizeMatchStatus('Not start')), true);
  assert.equal(normalizeMatchStatus('1st half'), '1st half');
});

test('parses booking codes, events, odds and tournament', () => {
  const [code] = parseBookingCodes(payload.data);
  assert.equal(code.shareCode, 'TL7RJZ');
  assert.equal(code.folds, 2);
  assert.equal(code.popularity, 4188);
  assert.equal(code.events.length, 2);
  const first = code.events[0];
  assert.equal(first.tournament, 'UEFA Champions League');
  assert.equal(first.matchStatus, 'not_started');
  assert.equal(first.isLive, false);
  assert.equal(first.markets[0].status, 'active');
  assert.deepEqual(first.markets[0].outcomes[0], { outcomeId: '3', name: 'Away', odds: '1.82', active: true, rawActive: 1 });
});

test('drops malformed codes and events', () => {
  const parsed = parseBookingCodes([{ shareCode: '../x', eventVOList: [] }, { shareCode: 'ABC123', eventVOList: [{ eventId: 'nope' }, event(1)] }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].events.length, 1);
  assert.throws(() => parseBookingCodes({}), (e) => e.code === 'FOOTBALLCOM_UPSTREAM_ERROR');
});

test('client is unavailable until the endpoint is configured', async () => {
  const client = createFootballComDataClient({ baseUrl: '', bookingCodesPath: '', fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(client.getBookingCodes(), (e) => e.code === 'FOOTBALLCOM_NOT_CONFIGURED' && e.status === 503);
});

test('client fetches read-only, caches, and rejects bad upstream responses', async () => {
  let calls = 0; let seen;
  let clock = 1780000000000;
  const client = createFootballComDataClient({ baseUrl: 'https://example.test', bookingCodesPath: '/codes', now: () => clock,
    fetchImpl: async (url, options) => { calls += 1; seen = { url: String(url), options }; return ok(payload); } });
  const first = await client.getBookingCodes({ limit: 5 });
  assert.equal(first.provider, 'Football.com Nigeria');
  assert.equal(first.codes.length, 1);
  assert.equal(seen.options.method, 'GET');
  assert.match(seen.url, /^https:\/\/example\.test\/codes\?_t=/);
  assert.equal((await client.getBookingCodes()).cached, true);
  assert.equal(calls, 1);
  clock += 31000;
  await client.getBookingCodes();
  assert.equal(calls, 2);

  const bad = createFootballComDataClient({ baseUrl: 'https://example.test', bookingCodesPath: '/codes', fetchImpl: async () => ok({ bizCode: 500, data: null }) });
  await assert.rejects(bad.getBookingCodes(), (e) => e.code === 'FOOTBALLCOM_UPSTREAM_ERROR' && e.status === 502);
  const down = createFootballComDataClient({ baseUrl: 'https://example.test', bookingCodesPath: '/codes', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.getBookingCodes(), (e) => e.code === 'FOOTBALLCOM_NETWORK_ERROR');
});
