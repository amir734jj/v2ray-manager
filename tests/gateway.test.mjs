import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once, EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { protocols } from '../generator/connections.mjs';
import { trackConnection, createStatusApp } from '../gateway/status.mjs';

const gatewayPath = fileURLToPath(new URL('../gateway/server.mjs', import.meta.url));
const healthcheckPath = fileURLToPath(new URL('../gateway/healthcheck.mjs', import.meta.url));
const run = promisify(execFile);

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = createTcpServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('status counters track socket lifetime, countries and each failed attempt once', async t => {
  const server = createServer(createStatusApp());
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const read = async () => (await fetch(`http://127.0.0.1:${port}/status.json`)).json();
  for (const [country, code] of [['US', 'US'], ['XX', 'unknown'], ['T1', 'T1'], ['invalid', 'unknown']]) {
    const socket = new EventEmitter();
    const before = await read();
    const fail = trackConnection('ws', 'vless', socket, { country });
    const active = await read();
    assert.equal(active.totals.active, 1);
    assert.equal(active.totals.total, before.totals.total + 1);
    assert.equal(active.countries.find(row => row.code === code).active, 1);
    fail();
    fail();
    socket.emit('close');
    socket.emit('close');
    const ended = await read();
    assert.equal(ended.totals.active, 0);
    assert.equal(ended.totals.errors, before.totals.errors + 1);
    assert.deepEqual(ended.clients, []);
  }
});

test('active client details preserve separate sockets, escape reported clients and disappear on close', async t => {
  const server = createServer(createStatusApp());
  const port = await listen(server);
  const first = new EventEmitter();
  const second = new EventEmitter();
  t.after(() => {
    first.emit('close');
    second.emit('close');
    return new Promise(resolve => server.close(resolve));
  });
  const read = async () => (await fetch(`http://127.0.0.1:${port}/status.json`)).json();
  trackConnection('ws', 'vless', first, {
    ip: '203.0.113.8', country: 'US', userAgent: '<script>alert(1)</script>',
    connectionId: 'test-connection-id', connectedAt: new Date(Date.now() - 10000).toISOString(),
  });
  trackConnection('ws', 'vmess', second, { ip: '203.0.113.8' });
  const { clients, clientGroups } = await read();
  assert.equal(clients.length, 2);
  assert.equal(clientGroups.length, 1);
  assert.equal(clientGroups[0].ip, '203.0.113.8');
  assert.equal(clientGroups[0].active, 2);
  assert.deepEqual(clientGroups[0].protocols, ['vless', 'vmess']);
  assert.deepEqual(clientGroups[0].countries.map(country => country.code).sort(), ['US', 'unknown'].sort());
  assert.equal(clients[0].connectionId, 'test-connection-id');
  assert.notEqual(clients[0].connectionId, clients[1].connectionId);
  assert.match(clients[1].connectionId, /^[0-9a-f-]{36}$/);
  assert.ok(clients[0].elapsedSeconds >= 10);
  assert.ok(clients[1].elapsedSeconds >= 0);
  assert.ok(clients.every(client => client.ip === '203.0.113.8'));
  assert.equal(clients[0].protocol, 'vless');
  assert.equal(clients[0].countryName, 'United States');
  assert.equal(clients[0].countryCode, 'US');
  assert.equal(clients[0].userAgent, '<script>alert(1)</script>');
  assert.equal(clients[0].transport, 'ws');
  assert.ok(Number.isFinite(Date.parse(clients[0].connectedAt)));
  assert.equal(clients[1].userAgent, 'Unknown');
  assert.equal(clients[1].countryName, 'Unknown');
  const collapsed = await (await fetch(`http://127.0.0.1:${port}/status`)).text();
  assert.match(collapsed, /Active clients by IP/);
  assert.match(collapsed, /\/status\?client=203\.0\.113\.8#active-clients/);
  assert.doesNotMatch(collapsed, /test-connection-id|&lt;script&gt;/);
  const detailUrl = `http://127.0.0.1:${port}/status?client=203.0.113.8`;
  const html = await (await fetch(detailUrl)).text();
  assert.match(html, /Hide connections/);
  assert.match(html, /href="\/status#active-clients"/);
  assert.match(html, /203\.0\.113\.8/);
  assert.match(html, /test-connection-id/);
  assert.match(html, /United States \(US\)/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(await (await fetch(detailUrl)).text(), /test-connection-id/);
  assert.deepEqual((await read()).clientGroups, clientGroups);
  first.emit('close');
  first.emit('close');
  const remaining = await read();
  assert.deepEqual(remaining.clients.map(client => client.protocol), ['vmess']);
  assert.equal(remaining.clientGroups[0].active, 1);
  assert.deepEqual(remaining.clientGroups[0].protocols, ['vmess']);
  second.emit('close');
  const empty = await read();
  assert.deepEqual(empty.clients, []);
  assert.deepEqual(empty.clientGroups, []);
});

async function testGateway(t, trustCloudflareHeaders) {
  const servers = new Map();
  const sockets = new Set();
  const env = {
    ...process.env,
    GATEWAY_PORT: String(await freePort()),
    V2RAY_UPSTREAM_HOST: '127.0.0.1',
    GATEWAY_TRUST_CLOUDFLARE_HEADERS: String(trustCloudflareHeaders),
  };
  let gateway;
  let logs = '';
  t.after(async () => {
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      const exited = once(gateway, 'exit');
      gateway.kill();
      await exited;
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers.values()].map(server => new Promise(resolve => server.close(resolve))));
  });
  for (const protocol of protocols) {
    const ws = createServer();
    servers.set(protocol, ws);
    ws.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    ws.on('upgrade', (req, socket, head) => {
      assert.equal(req.url, `/${protocol}`);
      if (req.headers['user-agent'] === 'v2rayNG-test (Android)') {
        assert.equal(req.headers.authorization, 'Bearer test-upgrade-secret');
        assert.equal(req.headers.cookie, 'session=test-upgrade-cookie');
        assert.equal(req.headers['x-api-key'], 'test-upgrade-api-key');
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      if (head.length) socket.write(head);
      socket.on('data', data => socket.write(data));
    });
    env[`V2RAY_${protocol.toUpperCase()}_PORT`] = String(await listen(ws));
  }
  gateway = spawn(process.execPath, ['--trace-deprecation', gatewayPath], { env, windowsHide: true });
  gateway.stderr.on('data', data => { logs += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${logs}`)), 5000);
    gateway.once('error', error => { clearTimeout(timer); reject(error); });
    gateway.once('exit', code => { clearTimeout(timer); reject(new Error(`Gateway exited (${code}): ${logs}`)); });
    gateway.stdout.on('data', data => {
      logs += data;
      if (logs.includes('WebSocket gateway listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const base = `http://127.0.0.1:${env.GATEWAY_PORT}`;
  const statusSnapshot = async () => (await fetch(`${base}/status.json`)).json();
  const connectionIds = [];
  async function waitForClosed() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = await statusSnapshot();
      if (status.totals.active === 0) return status;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Closed sockets must not remain active');
  }
  async function openTunnel(protocol, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port: Number(env.GATEWAY_PORT), path: `/${protocol}`,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
      });
      req.once('error', reject);
      req.once('response', response => reject(new Error(`Unexpected status ${response.statusCode}`)));
      req.once('upgrade', (_response, socket) => resolve(socket));
      req.end();
    });
  }

  await t.test('status page is read-only, Bootstrap styled and excludes monitoring requests', async () => {
    const before = await statusSnapshot();
    assert.deepEqual(before.totals, { active: 0, total: 0, errors: 0 });
    assert.equal(before.connections.length, 4);
    assert.ok(before.connections.every(row => row.transport === 'ws'));
    assert.deepEqual(before.clients, []);
    assert.deepEqual(before.clientGroups, []);
    for (const path of ['/', '/status', '/status.json']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      const body = await response.text();
      if (path !== '/status.json') {
        assert.match(body, /Gateway status/);
        assert.match(body, /http-equiv="refresh" content="5"/);
        assert.match(body, /class="table table-striped align-middle"/);
        assert.match(body, /Connections by country/);
        assert.match(body, /No active client connections/);
        for (const label of ['Open client sockets', 'Connection attempts', 'Proxy failures']) {
          assert.ok(body.includes(label));
        }
        assert.doesNotMatch(body, /Active tunnels|Total attempts|Proxy errors/);
        assert.doesNotMatch(body, /<script|<form|(?:src|href)="https?:\/\//);
      }
      const head = await fetch(`${base}${path}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      const rejected = await fetch(`${base}${path}`, { method: 'POST' });
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
    }
    assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok\n');
    await run(process.execPath, [healthcheckPath], { env });
    assert.deepEqual((await statusSnapshot()).totals, before.totals);
  });

  for (const protocol of protocols) {
    await t.test(`${protocol}: upgrades, streams binary data and tracks active country counters`, async () => {
      const socket = await openTunnel(protocol, {
        'CF-Connecting-IP': '203.0.113.42', 'CF-IPCountry': 'US',
        'User-Agent': 'v2rayNG-test (Android)',
        Authorization: 'Bearer test-upgrade-secret',
        Cookie: 'session=test-upgrade-cookie',
        'X-Api-Key': 'test-upgrade-api-key',
      });
      try {
        socket.on('error', () => {});
        const payload = Buffer.alloc(128 * 1024, 0xab);
        const chunks = [];
        const echoed = new Promise((resolve, reject) => {
          socket.once('error', reject);
          socket.on('data', chunk => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).length >= payload.length) resolve();
          });
        });
        socket.write(payload);
        await echoed;
        assert.deepEqual(Buffer.concat(chunks), payload);
        const status = await statusSnapshot();
        assert.equal(status.totals.active, 1);
        assert.equal(status.connections.find(row => row.protocol === protocol).active, 1);
        const country = status.countries.find(row => row.code === (trustCloudflareHeaders ? 'US' : 'unknown'));
        assert.equal(country.active, 1);
        assert.equal(status.clients.length, 1);
        assert.equal(status.clientGroups.length, 1);
        assert.equal(status.clientGroups[0].ip, status.clients[0].ip);
        assert.equal(status.clientGroups[0].active, 1);
        assert.deepEqual(status.clientGroups[0].protocols, [protocol]);
        assert.equal(status.clients[0].ip, trustCloudflareHeaders ? '203.0.113.42' : '127.0.0.1');
        assert.equal(status.clients[0].protocol, protocol);
        assert.equal(status.clients[0].countryName, trustCloudflareHeaders ? 'United States' : 'Unknown');
        assert.equal(status.clients[0].userAgent, 'v2rayNG-test (Android)');
        const { connectionId, connectedAt, elapsedSeconds } = status.clients[0];
        assert.match(connectionId, /^[0-9a-f-]{36}$/);
        assert.ok(!connectionIds.includes(connectionId));
        connectionIds.push(connectionId);
        assert.ok(Number.isFinite(Date.parse(connectedAt)));
        assert.ok(elapsedSeconds >= 0);
      } finally {
        socket.destroy();
      }
      assert.deepEqual((await waitForClosed()).clients, []);
    });
  }

  await t.test('unknown paths fail without counting proxy attempts', async () => {
    const before = await statusSnapshot();
    assert.equal((await fetch(`${base}/unknown`)).status, 404);
    assert.equal((await fetch(`${base}/vless-evil`)).status, 404);
    assert.equal((await fetch(`${base}/vless`)).status, 426);
    await assert.rejects(openTunnel('unknown'), /Unexpected status 404/);
    assert.deepEqual((await statusSnapshot()).totals, before.totals);
  });

  await t.test('unreachable upstreams are counted once and do not crash the gateway', async () => {
    await new Promise(resolve => servers.get('shadowsocks').close(resolve));
    await new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port: Number(env.GATEWAY_PORT), path: '/shadowsocks',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
      });
      req.once('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
      req.once('response', response => { response.resume(); resolve(); });
      req.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Unavailable upstream upgraded')); });
      req.end();
    });
    const status = await waitForClosed();
    assert.deepEqual(status.totals, { active: 0, total: 5, errors: 1 });
    assert.equal(status.connections.find(row => row.protocol === 'shadowsocks').errors, 1);
    assert.equal(status.countries.reduce((sum, row) => sum + row.total, 0), 5);
    assert.equal(status.countries.find(row => row.code === 'unknown').errors, 1);
    assert.doesNotMatch(JSON.stringify(status), /203\.0\.113|password|127\.0\.0/);
    await run(process.execPath, [healthcheckPath], { env });
  });

  await t.test('health check fails explicitly when the listener is unreachable', async () => {
    await assert.rejects(run(process.execPath, [healthcheckPath], {
      env: { ...env, GATEWAY_PORT: String(await freePort()) },
    }), error => error.code === 1 && /Gateway health check failed/.test(error.stderr));
  });

  await t.test('expanded request logs include headers and error details while redacting credentials', async () => {
    const response = await fetch(`${base}/healthz?token=test-query-secret`, {
      headers: {
        'User-Agent': 'gateway-http-log-test',
        'X-Test-Header': 'request-header-visible',
        Authorization: 'Bearer test-http-secret',
        'Proxy-Authorization': 'Basic test-proxy-secret',
        Cookie: 'session=test-http-cookie',
        'Set-Cookie': 'session=test-set-cookie',
        'X-Api-Key': 'test-http-api-key',
        'CF-Access-Jwt-Assertion': 'test-access-token',
      },
    });
    assert.equal(response.status, 200);
    await response.text();
    for (let attempt = 0; attempt < 50 && !logs.includes('request-header-visible'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.doesNotMatch(logs, /DEP0060|util\._extend/);
    assert.match(logs, /Gateway request\r?\n\s+method: "GET"/);
    assert.match(logs, /path: "\/healthz"/);
    assert.match(logs, /headers: \{/);
    assert.match(logs, /"user-agent": "gateway-http-log-test"/);
    assert.match(logs, /"user-agent": "v2rayNG-test \(Android\)"/);
    assert.match(logs, /"x-test-header": "request-header-visible"/);
    for (const header of ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'cf-access-jwt-assertion']) {
      assert.match(logs, new RegExp(`"${header}": "\\[REDACTED\\]"`));
    }
    assert.doesNotMatch(logs, /test-(?:upgrade|http|proxy|set|access|query)-(?:secret|cookie|api-key|token)/);
    assert.match(logs, /transport: "ws"/);
    assert.match(logs, /port: \d+/);
    assert.match(logs, /stack:/);
    const records = logs.split(/(?=^\[\d{2}:\d{2}:\d{2}\])/m);
    for (const [index, protocol] of protocols.entries()) {
      const id = connectionIds[index];
      const opened = records.find(record => record.includes('Gateway connection opened') && record.includes(id));
      const closed = records.find(record => record.includes('Gateway connection closed') && record.includes(id));
      assert.ok(opened, `Missing open log for ${id}`);
      assert.ok(closed, `Missing close log for ${id}`);
      for (const record of [opened, closed]) {
        assert.ok(record.includes(`protocol: "${protocol}"`));
        assert.ok(record.includes(`ip: "${trustCloudflareHeaders ? '203.0.113.42' : '127.0.0.1'}"`));
        assert.ok(record.includes(`country: "${trustCloudflareHeaders ? 'US' : 'unknown'}"`));
        assert.ok(record.includes('userAgent: "v2rayNG-test (Android)"'));
      }
      assert.match(opened, /headers: \{/);
      assert.match(closed, /durationMs: \d+/);
    }
    assert.match(logs, /Gateway proxy error.*ECONNREFUSED/);
    const failure = records.find(record => record.includes('Gateway proxy error'));
    assert.match(failure, /connectionId: "[0-9a-f-]{36}"/);
    assert.match(failure, /protocol: "shadowsocks"/);
  });

  await t.test('invalid Cloudflare metadata is ignored without interrupting traffic', async () => {
    for (const headers of [
      { 'CF-Connecting-IP': 'invalid-ip', 'CF-IPCountry': 'US' },
      { 'CF-Connecting-IP': '203.0.113.42', 'CF-IPCountry': 'invalid-country' },
    ]) {
      const socket = await openTunnel('vless', headers);
      socket.destroy();
    }
    const status = await waitForClosed();
    assert.deepEqual(status.totals, { active: 0, total: 7, errors: 1 });
    if (trustCloudflareHeaders) {
      assert.equal(status.countries.find(row => row.code === 'US').total, 4);
      assert.equal(status.countries.find(row => row.code === 'unknown').total, 3);
      assert.match(logs, /invalid CF-Connecting-IP ignored/);
      assert.match(logs, /invalid CF-IPCountry ignored/);
    } else {
      assert.deepEqual(status.countries, [{ code: 'unknown', name: 'Unknown', ...status.totals }]);
      assert.doesNotMatch(logs, /Gateway connection metadata/);
    }
  });
}

for (const trustCloudflareHeaders of [false, true]) {
  test(`gateway proxies WS (trust Cloudflare headers: ${trustCloudflareHeaders})`,
    { timeout: 30000 }, t => testGateway(t, trustCloudflareHeaders));
}
