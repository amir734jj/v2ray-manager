import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, symlink, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { configureClient, configureServerTransports, createConnectionUrls, protocols, validateHost } from './connections.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const host = 'proxy.example.com';
const uuid = '00000000-0000-4000-8000-000000000001';
const load = async name => JSON.parse(await readFile(join(root, 'templates', `${name}.template.json`), 'utf8'));

function assertClient(config, server, expectedHost = host) {
  for (const outbound of config.outbounds.filter(o => protocols.includes(o.protocol))) {
    const target = (outbound.settings.vnext ?? outbound.settings.servers)[0];
    const inbound = server.inbounds.find(i => i.protocol === outbound.protocol);
    assert.equal(target.address, expectedHost);
    assert.equal(target.port, 443);
    assert.equal(outbound.streamSettings.network, 'ws');
    assert.equal(outbound.streamSettings.security, 'tls');
    assert.equal(outbound.streamSettings.tlsSettings.serverName, expectedHost);
    assert.equal(outbound.streamSettings.tlsSettings.allowInsecure, undefined);
    assert.equal(outbound.streamSettings.wsSettings.headers.Host, expectedHost);
    assert.equal(outbound.streamSettings.wsSettings.path, inbound.streamSettings.wsSettings.path);
    if (target.users) assert.equal(target.users[0].id, inbound.settings.clients[0].id);
    else assert.equal(target.password, inbound.settings.clients?.[0].password ?? inbound.settings.password);
  }
}

test('all server transports match the gateway routes and remain internal/plain WS', async () => {
  const server = await load('server');
  const nginx = await readFile(join(root, 'nginx.conf'), 'utf8');
  for (const protocol of protocols) {
    const inbound = server.inbounds.find(i => i.protocol === protocol);
    assert.equal(inbound.streamSettings.network, 'ws');
    assert.equal(inbound.streamSettings.security, 'none');
    assert.equal(inbound.streamSettings.wsSettings.path, `/${protocol}`);
    assert.ok(nginx.includes(`location = /${protocol} {`));
    assert.ok(nginx.includes(`proxy_pass http://core:${inbound.port};`));
  }
  assert.equal(server.inbounds.find(i => i.protocol === 'shadowsocks').settings.network, 'tcp');
  assert.equal(server.log.error, undefined);
});

test('all client templates and configured clients use public WS/TLS on 443', async () => {
  const server = await load('server');
  for (const name of [...protocols, 'client']) {
    const template = await load(name);
    assertClient(template, server, 'YOUR_SERVER_IP');
    const direct = template.outbounds.filter(o => !protocols.includes(o.protocol));
    configureClient(template, server, host);
    assertClient(template, server);
    if (name === 'shadowsocks') assert.equal(template.inbounds[0].settings.udp, false);
    assert.deepEqual(template.outbounds.filter(o => !protocols.includes(o.protocol)), direct);
  }
});

test('exports encode public TLS, paths, credentials, and the Shadowsocks plugin', async () => {
  const server = await load('server');
  const snapshot = structuredClone(server);
  const urls = await createConnectionUrls(server, host);
  for (const protocol of ['vless', 'trojan']) {
    const url = new URL(urls[protocol]);
    assert.equal(url.hostname, host);
    assert.equal(url.port, '443');
    assert.equal(url.username, '00000000-0000-0000-0000-000000000000');
    for (const [key, value] of Object.entries({ type: 'ws', security: 'tls', sni: host, host, path: `/${protocol}` })) {
      assert.equal(url.searchParams.get(key), value);
    }
  }
  const vmess = JSON.parse(Buffer.from(urls.vmess.slice('vmess://'.length), 'base64'));
  assert.equal(vmess.add, host);
  assert.equal(vmess.port, '443');
  assert.equal(vmess.tls, 'tls');
  assert.equal(vmess.net, 'ws');
  assert.equal(vmess.host, host);
  assert.equal(vmess.path, '/vmess');
  assert.equal(vmess.id, '00000000-0000-0000-0000-000000000000');
  const ss = new URL(urls.shadowsocks);
  assert.equal(ss.hostname, host);
  assert.equal(ss.port, '443');
  assert.equal(ss.searchParams.get('plugin'), `v2ray-plugin;tls;mux=0;host=${host};path=/shadowsocks`);
  assert.equal(Buffer.from(ss.username, 'base64url').toString(), 'aes-256-gcm:00000000-0000-0000-0000-000000000000');
  assert.deepEqual(server, snapshot);
});

test('legacy TCP servers migrate without changing ports, credentials, or routing', async () => {
  const server = await load('server');
  const expected = structuredClone(server);
  for (const inbound of server.inbounds) {
    inbound.streamSettings = { network: 'tcp', tcpSettings: { header: { type: 'http' } } };
  }
  server.inbounds.find(i => i.protocol === 'shadowsocks').settings.network = 'tcp,udp';
  assert.deepEqual(configureServerTransports(server), expected);
});

test('invalid hostnames and failed converters surface errors', async () => {
  for (const value of [undefined, '', 'YOUR_SERVER_IP', 'https://proxy.example.com', 'proxy.example.com:443', 'proxy.example.com/path', 'user@proxy.example.com']) {
    assert.throws(() => validateHost(value));
  }
  assert.throws(() => configureServerTransports({ inbounds: [] }), /Missing vless/);
  const server = await load('server');
  server.inbounds.find(i => i.protocol === 'vless').settings.clients = [];
  await assert.rejects(createConnectionUrls(server, host), /Failed to generate vless/);
});

test('rotation bootstraps folders and migrates existing profiles on subsequent runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'v2ray-rotation-test-'));
  const run = promisify(execFile);
  try {
    await Promise.all([
      cp(join(root, 'templates'), join(dir, 'templates'), { recursive: true }),
      cp(join(root, 'rotate-id.mjs'), join(dir, 'rotate-id.mjs')),
      cp(join(root, 'connections.mjs'), join(dir, 'connections.mjs')),
      symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction'),
    ]);
    await run(process.execPath, [join(dir, 'rotate-id.mjs'), host, '--uuid', uuid]);
    let server = JSON.parse(await readFile(join(dir, 'v2ray-all', 'server.json'), 'utf8'));
    for (const protocol of protocols) {
      const profile = JSON.parse(await readFile(join(dir, protocol, 'client.json'), 'utf8'));
      assertClient(profile, server);
      assert.equal((await readFile(join(dir, protocol, 'qr.png'))).subarray(1, 4).toString(), 'PNG');
    }
    // Simulate an existing pre-WebSocket profile and exercise hostname-only CLI parsing.
    server.inbounds[0].streamSettings = { network: 'tcp', security: 'none' };
    await writeFile(join(dir, 'v2ray-all', 'server.json'), JSON.stringify(server));
    const nextHost = 'changed.example.com';
    await run(process.execPath, [join(dir, 'rotate-id.mjs'), nextHost]);
    server = JSON.parse(await readFile(join(dir, 'v2ray-all', 'server.json'), 'utf8'));
    assert.equal(server.inbounds[0].streamSettings.network, 'ws');
    for (const name of [...protocols, 'v2ray-all']) {
      const profile = JSON.parse(await readFile(join(dir, name, 'client.json'), 'utf8'));
      assertClient(profile, server, nextHost);
    }
    const ss = new URL((await readFile(join(dir, 'shadowsocks', 'connection.txt'), 'utf8')).trim());
    assert.ok(ss.searchParams.get('plugin').includes(nextHost));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
