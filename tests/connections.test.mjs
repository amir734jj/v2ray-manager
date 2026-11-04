import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, symlink, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { configureClient, configureServerTransports, createConnectionUrls, protocols, validateHost } from '../generator/connections.mjs';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const wsHost = 'proxy.example.com';
const uuid = '00000000-0000-4000-8000-000000000001';
const load = async name => JSON.parse(await readFile(join(projectDir, 'v2ray', 'templates', `${name}.template.json`), 'utf8'));

function assertClient(config, server, host = wsHost) {
  const proxyOutbounds = config.outbounds.filter(outbound => protocols.includes(outbound.protocol));
  assert.equal(new Set(proxyOutbounds.map(outbound => outbound.protocol)).size, proxyOutbounds.length);
  for (const outbound of proxyOutbounds) {
    const protocol = outbound.protocol;
    const inbound = server.inbounds.find(item => item.protocol === protocol);
    const target = (outbound.settings.vnext ?? outbound.settings.servers)[0];
    assert.equal(target.address, host);
    assert.equal(target.port, 443);
    assert.equal(outbound.streamSettings.network, 'ws');
    assert.equal(outbound.streamSettings.security, 'tls');
    assert.equal(outbound.streamSettings.tlsSettings.serverName, host);
    assert.equal(outbound.streamSettings.tlsSettings.allowInsecure, undefined);
    assert.equal(outbound.streamSettings.wsSettings.headers.Host, host);
    assert.equal(outbound.streamSettings.wsSettings.path, `/${protocol}`);
    if (target.users) assert.equal(target.users[0].id, inbound.settings.clients[0].id);
    else assert.equal(target.password, inbound.settings.clients?.[0].password ?? inbound.settings.password);
  }
  assert.equal(config.inbounds[0].port, 10808);
  assert.equal(config.routing.balancers, undefined);
  assert.equal(config.observatory, undefined);
  const tags = new Set(config.outbounds.map(outbound => outbound.tag));
  for (const rule of config.routing.rules) {
    assert.equal(rule.balancerTag, undefined);
    if (rule.outboundTag) assert.ok(tags.has(rule.outboundTag));
  }
  assert.equal(config.outbounds[0], proxyOutbounds[0]);
}

test('server exposes only four WS listeners and preserves ports and credentials', async () => {
  const template = await load('server');
  const original = structuredClone(template.inbounds);
  const server = configureServerTransports(template);
  assert.equal(server.inbounds.length, 4);
  for (const [index, inbound] of server.inbounds.entries()) {
    assert.equal(inbound.port, original[index].port);
    assert.deepEqual(inbound.settings, original[index].settings);
    assert.deepEqual(inbound.streamSettings, {
      network: 'ws', security: 'none', wsSettings: { path: `/${inbound.protocol}` },
    });
  }
  const snapshot = structuredClone(server);
  assert.deepEqual(configureServerTransports(server), snapshot);
});

test('all generated clients use only WS with direct routing and no transport balancers', async () => {
  const server = configureServerTransports(await load('server'));
  for (const name of [...protocols, 'client']) {
    const template = await load(name);
    const direct = template.outbounds.filter(outbound => !protocols.includes(outbound.protocol));
    const routing = structuredClone(template.routing);
    const tags = template.outbounds.map(outbound => outbound.tag);
    configureClient(template, server, wsHost);
    assertClient(template, server);
    if (name === 'shadowsocks') assert.equal(template.inbounds[0].settings.udp, false);
    assert.deepEqual(template.outbounds.filter(outbound => !protocols.includes(outbound.protocol)), direct);
    assert.deepEqual(template.routing, routing);
    assert.deepEqual(template.outbounds.map(outbound => outbound.tag), tags);
    const snapshot = structuredClone(template);
    assert.deepEqual(configureClient(template, server, wsHost), snapshot);
  }
});

test('share links encode only WS, TLS, public endpoint and Shadowsocks plugin', async () => {
  const server = configureServerTransports(await load('server'));
  const snapshot = structuredClone(server);
  const urls = createConnectionUrls(server, wsHost);
  assert.deepEqual(Object.keys(urls), protocols);
  for (const protocol of ['vless', 'trojan']) {
    const url = new URL(urls[protocol]);
    assert.equal(url.hostname, wsHost);
    assert.equal(url.port, '443');
    for (const [key, value] of Object.entries({ type: 'ws', security: 'tls', sni: wsHost, host: wsHost, path: `/${protocol}` })) {
      assert.equal(url.searchParams.get(key), value);
    }
  }
  const vmess = JSON.parse(Buffer.from(urls.vmess.slice('vmess://'.length), 'base64'));
  assert.equal(vmess.add, wsHost);
  assert.equal(vmess.port, '443');
  assert.equal(vmess.tls, 'tls');
  assert.equal(vmess.net, 'ws');
  assert.equal(vmess.path, '/vmess');
  assert.equal(vmess.sni, wsHost);
  const ss = new URL(urls.shadowsocks);
  assert.equal(ss.hostname, wsHost);
  assert.equal(ss.port, '443');
  assert.equal(ss.searchParams.get('plugin'), `v2ray-plugin;tls;mux=0;host=${wsHost};path=/shadowsocks`);
  assert.equal(Buffer.from(ss.username, 'base64url').toString(), 'aes-256-gcm:00000000-0000-0000-0000-000000000000');
  assert.deepEqual(server, snapshot);
});

test('non-WebSocket profiles require manual replacement rather than automatic migration', async () => {
  const server = await load('server');
  const oldClient = await load('vless');
  oldClient.outbounds[0].streamSettings = { network: 'tcp' };
  assert.throws(() => configureClient(oldClient, server, wsHost), /regenerate from templates/);
  server.inbounds[0].streamSettings = { network: 'tcp' };
  assert.throws(() => configureServerTransports(server), /use the WebSocket server template/);
});

test('invalid hostnames and missing credentials fail explicitly', async () => {
  for (const value of [undefined, '', 'YOUR_SERVER_IP', 'https://proxy.example.com', 'proxy.example.com:443', 'proxy.example.com/path', 'user@proxy.example.com']) {
    assert.throws(() => validateHost(value));
  }
  assert.throws(() => configureServerTransports({ inbounds: [] }), /Missing vless/);
  assert.throws(() => createConnectionUrls({ inbounds: [] }, wsHost), /Missing vless ws inbound/);
  const server = configureServerTransports(await load('server'));
  server.inbounds[0].settings.clients = [];
  assert.throws(() => createConnectionUrls(server, wsHost), /VLESS inbound has no client id/);
});

test('rotation updates WS profiles without deleting obsolete exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'v2ray-rotation-test-'));
  const run = promisify(execFile);
  try {
    await Promise.all([
      cp(join(projectDir, 'v2ray', 'templates'), join(dir, 'v2ray', 'templates'), { recursive: true }),
      cp(join(projectDir, 'generator'), join(dir, 'generator'), { recursive: true }),
      symlink(join(projectDir, 'node_modules'), join(dir, 'node_modules'), 'junction'),
    ]);
    await run(process.execPath, [join(dir, 'generator', 'rotate-id.mjs'), wsHost, '--uuid', uuid]);
    let server = JSON.parse(await readFile(join(dir, 'v2ray-all', 'server.json'), 'utf8'));
    for (const protocol of protocols) {
      assertClient(JSON.parse(await readFile(join(dir, protocol, 'client.json'), 'utf8')), server);
      assert.equal((await readFile(join(dir, protocol, 'qr.png'))).subarray(1, 4).toString(), 'PNG');
      await writeFile(join(dir, protocol, 'connection-grpc.txt'), 'obsolete');
      await writeFile(join(dir, protocol, 'qr-grpc.png'), 'obsolete');
    }
    const nextHost = 'changed.example.com';
    await run(process.execPath, [join(dir, 'generator', 'rotate-id.mjs'), nextHost]);
    server = JSON.parse(await readFile(join(dir, 'v2ray-all', 'server.json'), 'utf8'));
    assert.equal(server.inbounds.length, 4);
    for (const name of [...protocols, 'v2ray-all']) {
      assertClient(JSON.parse(await readFile(join(dir, name, 'client.json'), 'utf8')), server, nextHost);
    }
    for (const protocol of protocols) {
      for (const file of ['connection-grpc.txt', 'qr-grpc.png']) {
        assert.equal(await readFile(join(dir, protocol, file), 'utf8'), 'obsolete');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
