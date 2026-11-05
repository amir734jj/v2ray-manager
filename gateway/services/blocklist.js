import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export function normalizeIp(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) {
    throw new TypeError('A valid IPv4 or IPv6 address is required');
  }
  const address = ipaddr.process(value);
  return address.kind() === 'ipv6' ? address.toRFC5952String() : address.toString();
}
