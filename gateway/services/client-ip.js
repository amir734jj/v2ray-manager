import { isIP } from 'node:net';
import dns from 'node:dns/promises';
import proxyaddr from 'proxy-addr';
import { normalizeIp } from './blocklist.js';

// https://www.cloudflare.com/ips/
const isCloudflare = proxyaddr.compile([
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32',
  '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
]);
const isPrivateProxy = proxyaddr.compile('uniquelocal');
const trustNone = proxyaddr.compile([]);

export async function discoverTrustedProxies(logger) {
  let trustProxy = trustNone;
  let timer;
  let stopped = false;
  let previousState;

  async function refresh() {
    let records;
    try {
      records = await dns.lookup('coolify-proxy', { all: true });
    } catch (error) {
      if (!['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (stopped) return;
      trustProxy = trustNone;
      if (previousState !== error.code) {
        logger.warn({ proxyHost: 'coolify-proxy', errorCode: error.code },
          'Reverse proxy discovery unavailable; forwarded IP headers are ignored until Docker DNS recovers');
      }
      previousState = error.code;
      return;
    }
    if (stopped) return;
    const addresses = [...new Set(records.map(record => normalizeIp(record.address)))]
      .filter(isPrivateProxy).sort();
    trustProxy = proxyaddr.compile(addresses);
    const state = addresses.join(',');
    if (previousState !== state) {
      if (addresses.length) logger.info({ proxyHost: 'coolify-proxy', addresses }, 'Discovered trusted reverse proxy');
      else logger.warn('Reverse proxy DNS returned no private addresses; forwarded IP headers are ignored');
    }
    previousState = state;
  }

  function schedule() {
    timer = setTimeout(() => {
      refresh().catch(error => {
        if (stopped) return;
        trustProxy = trustNone;
        previousState = undefined;
        logger.error({ err: error }, 'Reverse proxy discovery failed unexpectedly; forwarded IP headers are ignored');
      }).finally(() => {
        if (!stopped) schedule();
      });
    }, 30000);
    timer.unref();
  }

  await refresh();
  schedule();
  return {
    trustProxy: address => trustProxy(address),
    close() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

function validIp(value) {
  return typeof value === 'string' && !value.includes('%') && isIP(value);
}

export function clientAddress(request, { trustProxy = trustNone, trustCloudflareHeaders = 'auto', logger }) {
  const { headers } = request;
  let ip = request.socket.remoteAddress ? normalizeIp(request.socket.remoteAddress) : null;
  if (ip && trustProxy(ip) && headers['x-forwarded-for'] !== undefined) {
    const value = headers['x-forwarded-for'];
    const chain = typeof value === 'string' ? value.split(',').map(address => address.trim()) : [];
    if (!chain.length || chain.some(address => !validIp(address))) {
      logger.warn('Gateway connection metadata: invalid X-Forwarded-For ignored');
    } else {
      ip = normalizeIp(proxyaddr({
        socket: request.socket,
        headers: { 'x-forwarded-for': chain.join(',') },
      }, trustProxy));
    }
  }
  let country = null;
  const cloudflareSource = ip && isCloudflare(ip);
  if (trustCloudflareHeaders !== false && cloudflareSource) {
    const clientIp = headers['cf-connecting-ip'];
    const clientCountry = headers['cf-ipcountry'];
    if (validIp(clientIp)) {
      ip = normalizeIp(clientIp);
      if (typeof clientCountry === 'string' && /^(?:[A-Z]{2}|T1)$/.test(clientCountry)) {
        country = clientCountry;
      } else if (clientCountry !== undefined) {
        logger.warn('Gateway connection metadata: invalid CF-IPCountry ignored');
      }
    } else if (clientIp !== undefined) {
      logger.warn('Gateway connection metadata: invalid CF-Connecting-IP ignored');
    }
  }
  return { ip, country: country && country !== 'XX' ? country : 'unknown' };
}
