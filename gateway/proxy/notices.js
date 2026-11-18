import { readFileSync } from 'node:fs';
import lodash from 'lodash';
import { clientAddress } from '../services/client-ip.js';

const renderNotice = lodash.template(
  readFileSync(new URL('../views/access-notice.html', import.meta.url), 'utf8'),
  { variable: 'notice' },
);

export async function serveAccessNotice(request, response, {
  blocklist, tunnels, logger, trustProxy, trustCloudflareHeaders, subscriptionToken,
}) {
  const headers = {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  function send(status, body) {
    response.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(body) });
    response.end(request.method === 'HEAD' ? undefined : body);
  }
  function notice(status, locals) {
    const body = renderNotice(locals);
    headers['content-type'] = 'text/html; charset=utf-8';
    send(status, body);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    headers.allow = 'GET, HEAD';
    send(405, 'Method Not Allowed\n');
    return;
  }
  try {
    const { ip } = clientAddress(request, { logger, trustProxy, trustCloudflareHeaders });
    if (!ip) {
      logger.warn('Access notice: client IP unavailable');
      send(503, 'Unable to determine your IP address. Contact the administrator.\n');
      return;
    }
    if (subscriptionToken !== undefined) {
      if (!tunnels) {
        logger.error('Subscription access notice: tunnel management unavailable');
        send(503, 'Unable to check this subscription. Contact the administrator.\n');
        return;
      }
      const { maxConcurrentIps, ipLimitReached } = await tunnels.subscriptionAccess(subscriptionToken, ip);
      notice(ipLimitReached ? 429 : 200, {
        title: ipLimitReached ? 'Subscription IP limit reached' : 'Subscription IP limit check',
        message: ipLimitReached
          ? 'This subscription has reached its concurrent IP limit'
          : "Your IP address is not restricted by this subscription's IP limit",
        advice: ipLimitReached
          ? 'Disconnect this subscription on another network and try again, or contact the administrator.'
          : 'If you still cannot connect, check the public blocked-IP page or contact the administrator for help.',
        detail: maxConcurrentIps > 0
          ? `This subscription allows up to ${maxConcurrentIps} simultaneous public IP addresses. Already-connected IPs may open more tunnels.`
          : 'This subscription has no concurrent IP limit.',
      });
      return;
    }
    const blocked = blocklist.has(ip);
    notice(blocked ? 403 : 200, {
      title: blocked ? 'Proxy access blocked' : 'Proxy access check',
      message: blocked ? 'Your IP address is blocked from using this proxy' : 'Your IP address is not blocked',
      advice: blocked
        ? 'Contact the administrator to ask about restoring access.'
        : 'If you still cannot connect, contact the administrator for help.',
    });
  } catch (error) {
    if (subscriptionToken !== undefined && [403, 404].includes(error.status) && error.expose) {
      logger.warn({ status: error.status }, 'Subscription access notice unavailable');
      send(error.status, `${error.message}\n`);
      return;
    }
    logger.error({ err: error }, 'Access notice lookup failed');
    send(503, 'Unable to check access. Contact the administrator.\n');
  }
}
