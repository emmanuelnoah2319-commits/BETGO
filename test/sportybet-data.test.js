import test from 'node:test';
import assert from 'node:assert/strict';
import { createSportyBetDataClient } from '../src/integrations/sportybet-data.js';

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


test('SportyBet dashboard hands a selected outcome into the review form with a timestamped odds snapshot', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /fixture-use-selection/);
  assert.match(source, /SportyBet odds snapshot/);
  assert.match(source, /outcome\.active !== true/);
  assert.match(source, /instruction-selection/);
  assert.match(source, /BETGO has not placed a bet/);
});

test('getMarketsForEvents refreshes once and returns labelled markets per event', async () => {
  let calls = 0;
  const client = createSportyBetDataClient({ fetchImpl: async () => { calls += 1; return response(sampleData); } });
  const result = await client.getMarketsForEvents(['sr:match:123456', 'sr:match:999']);
  assert.equal(calls, 1);
  assert.equal(result.events['sr:match:123456'].label, 'Home FC vs Away FC');
  assert.equal(result.events['sr:match:123456'].markets[0].outcomes.length, 3);
  assert.equal(result.events['sr:match:999'], undefined);
  await assert.rejects(client.getMarketsForEvents(['nope']), { code: 'INVALID_EVENT_ID', status: 400 });
  await assert.rejects(client.getMarketsForEvents([]), { code: 'INVALID_EVENT_ID' });
});
