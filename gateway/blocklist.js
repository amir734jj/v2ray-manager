import { isIP } from 'node:net';

export function normalizeIp(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) {
    throw new TypeError('A valid IPv4 or IPv6 address is required');
  }
  if (isIP(value) === 4) return value;
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = address.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (!mapped) return address;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
