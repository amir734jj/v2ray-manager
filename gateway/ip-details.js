import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { LRUCache } from 'lru-cache';
import { normalizeIp } from './blocklist.js';

const DAY = 24 * 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
const MAX_ENTRIES = 2000;
const MAX_PENDING = 4;

function parseDetails(body) {
  if (!body || body.success !== true) {
    throw new Error(`IP lookup rejected: ${typeof body?.message === 'string' ? body.message : 'invalid response'}`);
  }
  const text = value => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 256) throw new Error('Invalid IP lookup text field');
    return value;
  };
  const coordinate = (value, limit) => {
    if (value === undefined || value === null) return null;
    if (!Number.isFinite(value) || Math.abs(value) > limit) throw new Error('Invalid IP lookup coordinates');
    return value;
  };
  const asn = body.connection?.asn;
  if (asn !== undefined && asn !== null && (!Number.isSafeInteger(asn) || asn < 0)) {
    throw new Error('Invalid IP lookup ASN');
  }
  return {
    country: text(body.country), countryCode: text(body.country_code),
    region: text(body.region), city: text(body.city), postal: text(body.postal),
    latitude: coordinate(body.latitude, 90), longitude: coordinate(body.longitude, 180),
    isp: text(body.connection?.isp), organization: text(body.connection?.org),
    asn: asn ?? null, timezone: text(body.timezone?.id),
  };
}

export function createIpDetails({ logger, onChange, fetch: fetchIp = globalThis.fetch, now = Date.now }) {
  const cache = new LRUCache({ max: MAX_ENTRIES, ttl: DAY, fetchMethod: load });
  let pending = 0;
  let retryAfter = 0;

  async function load(ip, _staleValue, { options }) {
    pending++;
    try {
      const response = await fetchIp(`https://ipwho.is/${encodeURIComponent(ip)}`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const reset = Number.isFinite(seconds) ? now() + Math.max(0, seconds) * 1000 : Date.parse(header);
        retryAfter = Math.max(now() + RETRY_DELAY, Number.isFinite(reset) ? reset : now() + DAY);
        throw new Error('IP lookup rate limit reached');
      }
      if (!response.ok) throw new Error(`IP lookup HTTP ${response.status}`);
      return { status: 'ready', ...parseDetails(await response.json()) };
    } catch (error) {
      logger.warn({ ip, err: error }, 'IP details lookup failed');
      options.ttl = Math.max(RETRY_DELAY, retryAfter - now());
      return { status: 'unavailable' };
    } finally {
      pending--;
      onChange();
    }
  }

  return {
    lookup(value) {
      if (typeof value !== 'string' || value.includes('%') || !isIP(value)) {
        return { status: 'not-public' };
      }
      const ip = normalizeIp(value);
      if (ipaddr.parse(ip).range() !== 'unicast') return { status: 'not-public' };
      const existing = cache.get(ip);
      if (existing) return existing;
      if (retryAfter > now()) return { status: 'rate-limited' };
      if (pending >= MAX_PENDING) return { status: 'loading' };
      void cache.fetch(ip).catch(error => {
        logger.warn({ ip, err: error }, 'IP details cache fetch failed');
      });
      return { status: 'loading' };
    },
  };
}
