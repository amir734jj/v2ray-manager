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
    const fail = trackConnection('ws', 'vless', socket, country);
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
  }
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
      const socket = await openTunnel(protocol, { 'CF-Connecting-IP': '203.0.113.42', 'CF-IPCountry': 'US' });
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
      } finally {
        socket.destroy();
      }
      await waitForClosed();
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

  await t.test('logging preserves privacy defaults and avoids deprecated proxy APIs', () => {
    assert.doesNotMatch(logs, /DEP0060|util\._extend/);
    for (const protocol of protocols) {
      const ip = trustCloudflareHeaders ? '203.0.113.42' : '127.0.0.1';
      const country = trustCloudflareHeaders ? 'US' : 'unknown';
      assert.ok(logs.includes(`WS ${protocol} | IP=${ip} | country=${country}`));
    }
    assert.match(logs, /Gateway proxy error.*ECONNREFUSED/);
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
