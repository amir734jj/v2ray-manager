import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { normalizeIp } from './blocklist.js';

// https://www.cloudflare.com/ips/
const cloudflareRanges = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32',
  '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
].map(value => ipaddr.parseCIDR(value));

export function parseTrustedProxies(value = '') {
  if (value === '') return [];
  return value.split(',').map(entry => {
    const address = entry.trim();
    try {
      if (address.includes('/')) return ipaddr.parseCIDR(address);
      const parsed = ipaddr.parse(normalizeIp(address));
      return [parsed, parsed.kind() === 'ipv4' ? 32 : 128];
    } catch {
      throw new Error('GATEWAY_TRUSTED_PROXIES must contain comma-separated IP addresses or CIDR ranges');
    }
  });
}

function matches(ip, ranges) {
  if (!ip) return false;
  const address = ipaddr.process(ip);
  return ranges.some(([network, prefix]) => address.kind() === network.kind() && address.match(network, prefix));
}

function validIp(value) {
  return typeof value === 'string' && !value.includes('%') && isIP(value);
}

export function clientAddress(request, { trustedProxies = [], trustCloudflareHeaders = 'auto', logger }) {
  const { headers } = request;
  let ip = request.socket.remoteAddress ? normalizeIp(request.socket.remoteAddress) : null;
  const trustedPeer = matches(ip, trustedProxies);
  if (trustedPeer && headers['x-forwarded-for'] !== undefined) {
    const value = headers['x-forwarded-for'];
    const chain = typeof value === 'string' ? value.split(',').map(address => address.trim()) : [];
    if (!chain.length || chain.some(address => !validIp(address))) {
      logger.warn('Gateway connection metadata: invalid X-Forwarded-For ignored');
    } else {
      for (let index = chain.length - 1; index >= 0 && matches(ip, trustedProxies); index--) {
        ip = normalizeIp(chain[index]);
      }
    }
  }
  let country = null;
  const cloudflareSource = matches(ip, cloudflareRanges)
    || (trustCloudflareHeaders === true && trustedProxies.length === 0);
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
