import { normalizeEvent } from './sportybet-data.js';

export const FOOTBALLCOM_PLATFORM = 'Football.com Nigeria';

function providerError(message, code = 'FOOTBALLCOM_UPSTREAM_ERROR', status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// Football.com reports "Not start" where SportyBet reports "not_started". Map it so the shared status helpers work.
export function normalizeMatchStatus(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (['not start', 'not started'].includes(text)) return 'not_started';
  return String(value ?? 'unknown') || 'unknown';
}

function isoOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? new Date(number).toISOString() : null;
}

/**
 * Pure parser for the Football.com booking-code list payload ({ bizCode: 10000, data: [{ shareCode, eventVOList, ... }] }).
 * Each code carries only the selections its author booked, so `markets` are selections, not full market lists.
 */
export function parseBookingCodes(data) {
  if (!Array.isArray(data)) throw providerError('Football.com booking-code response had an unexpected shape.');
  return data.map((entry) => {
    const shareCode = typeof entry?.shareCode === 'string' ? entry.shareCode.trim() : '';
    if (!/^[A-Za-z0-9]{4,12}$/.test(shareCode)) return null;
    const events = (Array.isArray(entry.eventVOList) ? entry.eventVOList : [])
      .map((event) => normalizeEvent({ ...event, matchStatus: normalizeMatchStatus(event?.matchStatus) }, null))
      .filter(Boolean);
    const totalOdds = Number(entry.totalOdds);
    return {
      shareCode,
      folds: Number.isFinite(Number(entry.foldsAmount)) ? Number(entry.foldsAmount) : events.length,
      totalOdds: Number.isFinite(totalOdds) && totalOdds > 0 ? totalOdds : null,
      popularity: Number.isFinite(Number(entry.popularity)) ? Number(entry.popularity) : 0,
      createdAt: isoOrNull(entry.createTime),
      deadline: isoOrNull(entry.deadline),
      events
    };
  }).filter(Boolean);
}

/**
 * Read-only Football.com Nigeria data client. It never logs in or places a wager. The upstream URL is configuration
 * (FOOTBALLCOM_API_BASE_URL + FOOTBALLCOM_BOOKING_CODES_PATH) because no official, documented endpoint has been verified.
 */
export function createFootballComDataClient({
  baseUrl = process.env.FOOTBALLCOM_API_BASE_URL || '',
  bookingCodesPath = process.env.FOOTBALLCOM_BOOKING_CODES_PATH || '',
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
      const response = await fetchImpl(url, { method: 'GET', signal: controller.signal, headers: { Accept: 'application/json', 'Current-Country': 'NG' } });
      if (!response.ok) throw providerError(`Football.com returned HTTP ${response.status}.`, 'FOOTBALLCOM_UPSTREAM_HTTP_ERROR');
      let body;
      try { body = await response.json(); } catch { throw providerError('Football.com returned invalid JSON.'); }
      if (!body || body.bizCode !== 10000 || !body.data) throw providerError('Football.com response did not indicate success.');
      return body.data;
    } catch (error) {
      if (error?.name === 'AbortError') throw providerError('Football.com request timed out.', 'FOOTBALLCOM_TIMEOUT', 504);
      if (error?.code) throw error;
      throw providerError('Could not reach Football.com. Try again later.', 'FOOTBALLCOM_NETWORK_ERROR', 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getBookingCodes({ limit = 20, forceRefresh = false } = {}) {
    if (!baseUrl || !bookingCodesPath) {
      throw providerError('Football.com data is not configured. Set FOOTBALLCOM_API_BASE_URL and FOOTBALLCOM_BOOKING_CODES_PATH.', 'FOOTBALLCOM_NOT_CONFIGURED', 503);
    }
    const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 20));
    const cached = cache.get('codes');
    if (!forceRefresh && cached && cached.expiresAt > now()) return { ...cached.value, codes: cached.value.codes.slice(0, safeLimit), cached: true };
    const url = new URL(bookingCodesPath, baseUrl);
    url.searchParams.set('_t', String(now()));
    const codes = parseBookingCodes(await fetchJson(url));
    const value = {
      provider: FOOTBALLCOM_PLATFORM, region: 'NG', fetchedAt: new Date(now()).toISOString(), codes, cached: false,
      notice: 'Shared booking codes are read-only data. Odds change at any time. No wager was placed.'
    };
    cache.set('codes', { value, expiresAt: now() + cacheTtlMs });
    return { ...value, codes: codes.slice(0, safeLimit) };
  }

  return Object.freeze({ getBookingCodes });
}

export const footballComDataClient = createFootballComDataClient();
