import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import lodash from 'lodash';

export function normalizeIp(value) {
  if (!lodash.isString(value) || value.includes('%') || !isIP(value)) {
    throw new TypeError('A valid IPv4 or IPv6 address is required');
  }
  const address = ipaddr.process(value);
  return address.kind() === 'ipv6' ? address.toRFC5952String() : address.toString();
}

export function isPublicIp(value) {
  if (!lodash.isString(value) || value.includes('%') || !isIP(value)) return false;
  try {
    const ip = normalizeIp(value);
    return ipaddr.parse(ip).range() === 'unicast';
  } catch {
    return false;
  }
}
