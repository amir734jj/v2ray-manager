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
const grpcHost = 'grpc.example.com';
const uuid = '00000000-0000-4000-8000-000000000001';
const load = async name => JSON.parse(await readFile(join(projectDir, 'v2ray', 'templates', `${name}.template.json`), 'utf8'));

function assertClient(config, server, expectedWsHost = wsHost, expectedGrpcHost = grpcHost) {
  const configuredProtocols = [...new Set(
    config.outbounds.filter(outbound => protocols.includes(outbound.protocol)).map(outbound => outbound.protocol),
  )];
  for (const protocol of configuredProtocols) {
    for (const network of ['ws', 'grpc']) {
      const outbound = config.outbounds.find(item => item.tag === `${protocol}-${network}`);
      const inbound = server.inbounds.find(
        item => item.protocol === protocol && item.streamSettings.network === network,
      );
      const expectedHost = network === 'ws' ? expectedWsHost : expectedGrpcHost;
      const target = (outbound.settings.vnext ?? outbound.settings.servers)[0];
      assert.equal(target.address, expectedHost);
      assert.equal(target.port, 443);
      assert.equal(outbound.streamSettings.network, network);
      assert.equal(outbound.streamSettings.security, 'tls');
      assert.equal(outbound.streamSettings.tlsSettings.serverName, expectedHost);
      assert.equal(outbound.streamSettings.tlsSettings.allowInsecure, undefined);
      if (network === 'ws') {
        assert.equal(outbound.streamSettings.wsSettings.headers.Host, expectedHost);
        assert.equal(outbound.streamSettings.wsSettings.path, inbound.streamSettings.wsSettings.path);
      } else {
        assert.equal(outbound.streamSettings.grpcSettings.serviceName, inbound.streamSettings.grpcSettings.serviceName);
      }
      if (target.users) assert.equal(target.users[0].id, inbound.settings.clients[0].id);
      else assert.equal(target.password, inbound.settings.clients?.[0].password ?? inbound.settings.password);
    }
    const balancer = config.routing.balancers.find(item => item.tag === `${protocol}-auto`);
    assert.deepEqual(balancer.selector, [`${protocol}-ws`, `${protocol}-grpc`]);
    assert.equal(balancer.strategy.type, 'leastping');
    assert.equal(balancer.fallbackTag, `${protocol}-ws`);
  }
  assert.deepEqual(
    config.observatory.subjectSelector,
    configuredProtocols.flatMap(protocol => [`${protocol}-ws`, `${protocol}-grpc`]),
  );
}

test('all server transports include internal WS and gRPC listeners', async () => {
  const server = configureServerTransports(await load('server'));
  const gateway = await readFile(join(projectDir, 'gateway', 'server.mjs'), 'utf8');
  for (const protocol of protocols) {
    const wsInbound = server.inbounds.find(i => i.protocol === protocol && i.streamSettings.network === 'ws');
    const grpcInbound = server.inbounds.find(i => i.protocol === protocol && i.streamSettings.network === 'grpc');
    assert.equal(wsInbound.streamSettings.security, 'none');
    assert.equal(wsInbound.streamSettings.wsSettings.path, `/${protocol}`);
    assert.equal(grpcInbound.streamSettings.security, 'none');
    assert.equal(grpcInbound.streamSettings.grpcSettings.serviceName, `${protocol}-grpc`);
    assert.ok(gateway.includes(`'/${protocol}': process.env.V2RAY_${protocol.toUpperCase()}_PORT ?? '${wsInbound.port}'`));
  }
  assert.equal(server.inbounds.length, 8);
  configureServerTransports(server);
  assert.equal(server.inbounds.length, 8);
  assert.ok(server.inbounds.filter(i => i.protocol === 'shadowsocks').every(i => i.settings.network === 'tcp'));
  assert.equal(server.log.error, undefined);
});

test('all configured clients use paired WS/gRPC outbounds with automatic least-ping selection', async () => {
  const server = configureServerTransports(await load('server'));
  for (const name of [...protocols, 'client']) {
    const template = await load(name);
    const direct = template.outbounds.filter(o => !protocols.includes(o.protocol));
    configureClient(template, server, wsHost, grpcHost);
    assertClient(template, server);
    if (name === 'shadowsocks') assert.equal(template.inbounds[0].settings.udp, false);
    assert.deepEqual(template.outbounds.filter(o => !protocols.includes(o.protocol)), direct);
  }
});

test('exports encode WS and gRPC links while preserving the Shadowsocks plugin link', async () => {
  const server = configureServerTransports(await load('server'));
  const snapshot = structuredClone(server);
  const urls = await createConnectionUrls(server, wsHost, grpcHost);
  for (const protocol of ['vless', 'trojan']) {
    const wsUrl = new URL(urls.ws[protocol]);
    assert.equal(wsUrl.hostname, wsHost);
    assert.equal(wsUrl.port, '443');
    assert.equal(wsUrl.username, '00000000-0000-0000-0000-000000000000');
    for (const [key, value] of Object.entries({ type: 'ws', security: 'tls', sni: wsHost, host: wsHost, path: `/${protocol}` })) {
      assert.equal(wsUrl.searchParams.get(key), value);
    }
    const grpcUrl = new URL(urls.grpc[protocol]);
    assert.equal(grpcUrl.hostname, grpcHost);
    assert.equal(grpcUrl.port, '443');
    assert.equal(grpcUrl.searchParams.get('type'), 'grpc');
    assert.equal(grpcUrl.searchParams.get('security'), 'tls');
    assert.equal(grpcUrl.searchParams.get('sni'), grpcHost);
    assert.equal(grpcUrl.searchParams.get('serviceName'), `${protocol}-grpc`);
  }
  const vmess = JSON.parse(Buffer.from(urls.grpc.vmess.slice('vmess://'.length), 'base64'));
  assert.equal(vmess.add, grpcHost);
  assert.equal(vmess.port, '443');
  assert.equal(vmess.tls, 'tls');
  assert.equal(vmess.net, 'grpc');
  assert.equal(vmess.path, 'vmess-grpc');
  assert.equal(vmess.id, '00000000-0000-0000-0000-000000000000');
  assert.equal(vmess.sni, grpcHost);
  const wsVmess = JSON.parse(Buffer.from(urls.ws.vmess.slice('vmess://'.length), 'base64'));
  assert.equal(wsVmess.net, 'ws');
  assert.equal(wsVmess.path, '/vmess');
  assert.equal(wsVmess.host, wsHost);
  assert.equal(wsVmess.sni, wsHost);
  assert.equal(urls.grpc.shadowsocks, undefined);
  const ss = new URL(urls.ws.shadowsocks);
  assert.equal(ss.hostname, wsHost);
  assert.equal(ss.port, '443');
  assert.equal(ss.searchParams.get('plugin'), `v2ray-plugin;tls;mux=0;host=${wsHost};path=/shadowsocks`);
  assert.equal(Buffer.from(ss.username, 'base64url').toString(), 'aes-256-gcm:00000000-0000-0000-0000-000000000000');
  assert.deepEqual(server, snapshot);
});

test('legacy TCP servers migrate without changing ports, credentials, or routing', async () => {
  const server = await load('server');
  const expected = configureServerTransports(structuredClone(server));
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
  assert.throws(() => createConnectionUrls({ inbounds: [] }, wsHost, grpcHost), /Missing vless ws inbound/);
  const server = configureServerTransports(await load('server'));
  server.inbounds.find(i => i.protocol === 'vless').settings.clients = [];
  assert.throws(() => createConnectionUrls(server, wsHost, grpcHost), /VLESS inbound has no client id/);
});

test('rotation bootstraps folders and migrates existing profiles on subsequent runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'v2ray-rotation-test-'));
  const run = promisify(execFile);
  try {
    await Promise.all([
      cp(join(projectDir, 'v2ray', 'templates'), join(dir, 'v2ray', 'templates'), { recursive: true }),
      cp(join(projectDir, 'generator'), join(dir, 'generator'), { recursive: true }),
      symlink(join(projectDir, 'node_modules'), join(dir, 'node_modules'), 'junction'),
    ]);
    await run(process.execPath, [
      join(dir, 'generator', 'rotate-id.mjs'),
      wsHost,
      '--grpc-host',
      grpcHost,
      '--uuid',
      uuid,
    ]);
    let server = JSON.parse(await readFile(join(dir, 'v2ray-all', 'server.json'), 'utf8'));
    for (const protocol of protocols) {
      const profile = JSON.parse(await readFile(join(dir, protocol, 'client.json'), 'utf8'));
      assertClient(profile, server);
      assert.equal((await readFile(join(dir, protocol, 'qr.png'))).subarray(1, 4).toString(), 'PNG');
      if (protocol !== 'shadowsocks') {
        assert.equal((await readFile(join(dir, protocol, 'qr-grpc.png'))).subarray(1, 4).toString(), 'PNG');
      }
    }
    // Simulate an existing pre-WebSocket profile and exercise hostname-only CLI parsing.
    server.inbounds[0].streamSettings = { network: 'tcp', security: 'none' };
    await writeFile(join(dir, 'v2ray-all', 'server.json'), JSON.stringify(server));
    const nextHost = 'changed.example.com';
    const nextGrpcHost = 'grpc-changed.example.com';
    await run(process.execPath, [
      join(dir, 'generator', 'rotate-id.mjs'),
      nextHost,
      '--grpc-host',
      nextGrpcHost,
    ]);
    server = JSON.parse(await readFile(join(dir, 'v2ray-all', 'server.json'), 'utf8'));
    assert.equal(server.inbounds[0].streamSettings.network, 'ws');
    for (const name of [...protocols, 'v2ray-all']) {
      const profile = JSON.parse(await readFile(join(dir, name, 'client.json'), 'utf8'));
      assertClient(profile, server, nextHost, nextGrpcHost);
    }
    const ss = new URL((await readFile(join(dir, 'shadowsocks', 'connection.txt'), 'utf8')).trim());
    assert.ok(ss.searchParams.get('plugin').includes(nextHost));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
