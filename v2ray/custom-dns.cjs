const { readFileSync, writeFileSync } = require('node:fs');
const { isIP } = require('node:net');

const address = process.env.V2RAY_DNS_SERVER;
if (!isIP(address)) {
  throw new Error('V2RAY_DNS_SERVER must be an IP address');
}

const config = JSON.parse(readFileSync('/etc/v2ray/server.json', 'utf8'));
config.dns.servers = [address];
writeFileSync('/tmp/v2ray-server.json', JSON.stringify(config));
