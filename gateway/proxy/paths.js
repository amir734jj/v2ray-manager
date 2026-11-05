export function parseTunnelPath(path) {
  const match = /^\/(vless|vmess|trojan)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(path);
  return match ? { protocol: match[1], credential: match[2] } : null;
}
