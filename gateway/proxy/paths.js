import { protocols } from '@v2ray-manager/generator';

export function parseTunnelPath(path) {
  const match = /^\/([a-z]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(path);
  return match && protocols.includes(match[1]) ? { protocol: match[1], credential: match[2] } : null;
}
