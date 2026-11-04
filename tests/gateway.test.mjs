import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createHttp2Server, connect, constants } from 'node:http2';
import { createServer as createTcpServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { protocols } from '../generator/connections.mjs';
import { trackConnection, statusResponse } from '../gateway/status.mjs';

const gatewayPath = fileURLToPath(new URL('../gateway/server.mjs', import.meta.url));
const healthcheckPath = fileURLToPath(new URL('../gateway/healthcheck.mjs', import.meta.url));
const run = promisify(execFile);

test('status counters track socket lifetime and count each failed attempt once', () => {
  const socket = new EventEmitter();
  const fail = trackConnection('ws', 'vless', socket);
  const read = () => JSON.parse(statusResponse('/status.json', 'GET').body);
  assert.deepEqual(read().totals, { active: 1, total: 1, errors: 0 });
  fail();
  fail();
  assert.deepEqual(read().totals, { active: 1, total: 1, errors: 1 });
  socket.emit('close');
  socket.emit('close');
  assert.deepEqual(read().totals, { active: 0, total: 1, errors: 1 });
  assert.equal(statusResponse('/', 'GET').code, 200);
  assert.equal(statusResponse('/', 'HEAD').body, '');
  assert.equal(statusResponse('/', 'DELETE').code, 405);
  assert.equal(statusResponse('/unknown', 'GET'), null);
});

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

async function http2Request(port, path, requestHeaders = {}) {
  const session = connect(`http://127.0.0.1:${port}`);
  try {
    return await new Promise((resolve, reject) => {
      session.once('error', reject);
      const stream = session.request({ ':method': 'POST', ...requestHeaders, ':path': path });
      const chunks = [];
      let headers;
      let trailers;
      stream.on('response', value => { headers = value; });
      stream.on('trailers', value => { trailers = value; });
      stream.on('data', chunk => chunks.push(chunk));
      stream.once('error', reject);
      stream.once('end', () => resolve({ headers, trailers, body: Buffer.concat(chunks).toString() }));
      stream.end();
    });
  } finally {
    session.destroy();
  }
}

async function testGateway(t, trustCloudflareHeaders) {
  const servers = [];
  const sockets = new Set();
  const sessions = new Set();
  const grpcServers = new Map();
  const observed = new Map();
  const env = {
    ...process.env,
    GATEWAY_PORT: String(await freePort()),
    GATEWAY_GRPC_PORT: String(await freePort()),
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
    for (const session of sessions) session.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  });

  for (const protocol of protocols) {
    const ws = createServer();
    servers.push(ws);
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

    const grpc = createHttp2Server();
    servers.push(grpc);
    grpcServers.set(protocol, grpc);
    grpc.on('session', session => {
      sessions.add(session);
      session.once('close', () => sessions.delete(session));
    });
    grpc.on('stream', (stream, headers) => {
      const record = { headers, trailers: {}, closed: new Promise(resolve => stream.once('close', resolve)) };
      observed.set(headers[':path'], record);
      stream.on('error', () => {});
      stream.on('trailers', trailers => { record.trailers = trailers; });
      stream.respond({
        ':status': 200,
        'content-type': 'application/grpc',
        'upstream-protocol': protocol,
      }, { waitForTrailers: true });
      if (headers[':path'].endsWith('/Reset')) {
        stream.write('initial');
        setTimeout(() => stream.close(constants.NGHTTP2_INTERNAL_ERROR), 30);
        return;
      }
      stream.on('data', chunk => stream.write(chunk));
      stream.once('end', () => stream.end());
      stream.once('wantTrailers', () => {
        stream.sendTrailers({
          'grpc-status': headers[':path'].endsWith('/Status') ? '13' : '0',
          'grpc-message': 'complete',
          'custom-metadata': 'preserved',
        });
      });
    });
    env[`V2RAY_${protocol.toUpperCase()}_GRPC_PORT`] = String(await listen(grpc));
  }

  gateway = spawn(process.execPath, ['--trace-deprecation', gatewayPath], { env, windowsHide: true });
  gateway.stderr.on('data', data => { logs += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${logs}`)), 5000);
    gateway.once('error', reject);
    gateway.once('exit', code => reject(new Error(`Gateway exited (${code}): ${logs}`)));
    gateway.stdout.on('data', data => {
      logs += data;
      if (logs.includes('WebSocket gateway listening') && logs.includes('gRPC gateway listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const wsPort = Number(env.GATEWAY_PORT);
  const grpcPort = Number(env.GATEWAY_GRPC_PORT);
  const statusSnapshot = async () => (await fetch(`http://127.0.0.1:${wsPort}/status.json`)).json();

  await t.test('status page is read-only, uncached and excludes monitoring requests', async () => {
    const before = await statusSnapshot();
    assert.deepEqual(before.totals, { active: 0, total: 0, errors: 0 });
    assert.equal(before.connections.length, 8);
    const response = await fetch(`http://127.0.0.1:${wsPort}/status`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await response.text();
    assert.match(html, /Gateway status/);
    assert.match(html, /http-equiv="refresh" content="5"/);
    assert.doesNotMatch(html, /<script|<form|https?:\/\//);
    const head = await fetch(`http://127.0.0.1:${wsPort}/status`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const path of ['/', '/status', '/status.json']) {
      const rejected = await fetch(`http://127.0.0.1:${wsPort}${path}`, { method: 'POST' });
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
      const h2 = await http2Request(grpcPort, path, { ':method': 'GET' });
      assert.equal(h2.headers[':status'], 200);
      assert.equal((await http2Request(grpcPort, path)).headers[':status'], 405);
    }
    assert.deepEqual((await statusSnapshot()).totals, before.totals);
  });

  await t.test('both listeners are responsive and deployment health check succeeds', async () => {
    assert.equal(await (await fetch(`http://127.0.0.1:${wsPort}/healthz`)).text(), 'ok\n');
    const health = await http2Request(grpcPort, '/healthz');
    assert.equal(health.headers[':status'], 200);
    assert.equal(health.body, 'ok\n');
    await run(process.execPath, [healthcheckPath], { env });
  });

  for (const protocol of protocols) {
    await t.test(`${protocol}: existing WebSocket routing still upgrades and streams`, async () => {
      await new Promise((resolve, reject) => {
        const req = request({
          hostname: '127.0.0.1',
          port: wsPort,
          path: `/${protocol}`,
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'CF-Connecting-IP': '203.0.113.42',
            'CF-IPCountry': 'US',
          },
        });
        req.once('error', reject);
        req.once('response', response => reject(new Error(`Unexpected status ${response.statusCode}`)));
        req.once('upgrade', (response, socket, head) => {
          assert.equal(response.statusCode, 101);
          const payload = Buffer.from(`websocket-${protocol}`);
          const chunks = [head];
          socket.on('error', reject);
          socket.on('data', chunk => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).length >= payload.length) {
              assert.deepEqual(Buffer.concat(chunks), payload);
              socket.destroy();
              resolve();
            }
          });
          socket.write(payload);
        });
        req.end();
      });
    });

    await t.test(`${protocol}: gRPC streams before half-close and preserves binary frames and trailers`, async () => {
      const session = connect(`http://127.0.0.1:${grpcPort}`);
      const path = `/${protocol}-grpc/Tun`;
      try {
        const stream = session.request({
          ':method': 'POST',
          ':path': path,
          'content-type': 'application/grpc',
          te: 'trailers',
          'grpc-timeout': '30S',
          'client-metadata': 'preserved',
          'cf-connecting-ip': '2001:db8::42',
          'cf-ipcountry': 'DE',
        }, { waitForTrailers: true });
        const firstFrame = Buffer.from([0, 0, 0, 0, 3, 0, 255, 1]);
        const secondFrame = Buffer.from([0, 0, 0, 0, 2, 128, 0]);
        const chunks = [];
        let responseTrailers;
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('trailers', trailers => { responseTrailers = trailers; });
        stream.once('wantTrailers', () => stream.sendTrailers({ 'request-trailer': 'preserved' }));
        const response = once(stream, 'response');
        const firstData = once(stream, 'data');
        const ended = once(stream, 'end');
        stream.write(firstFrame);
        const [headers] = await response;
        assert.equal(headers[':status'], 200);
        assert.equal(headers['upstream-protocol'], protocol);
        await firstData;
        assert.deepEqual(Buffer.concat(chunks), firstFrame);
        const status = await statusSnapshot();
        const counter = status.connections.find(row => row.transport === 'grpc' && row.protocol === protocol);
        assert.equal(counter.active, 1);
        assert.equal(counter.total, 1);
        assert.equal(counter.errors, 0);
        stream.end(secondFrame);
        await ended;
        assert.deepEqual(Buffer.concat(chunks), Buffer.concat([firstFrame, secondFrame]));
        assert.equal(responseTrailers['grpc-status'], '0');
        assert.equal(responseTrailers['grpc-message'], 'complete');
        assert.equal(responseTrailers['custom-metadata'], 'preserved');
        assert.equal(observed.get(path).headers[':path'], path);
        assert.equal(observed.get(path).headers['client-metadata'], 'preserved');
        assert.equal(observed.get(path).headers['grpc-timeout'], '30S');
        assert.equal(observed.get(path).trailers['request-trailer'], 'preserved');
      } finally {
        session.destroy();
      }
    });
  }

  await t.test('unknown paths cannot escape exact service-prefix routing', async () => {
    for (const path of ['/unknown/Tun', '/vless-grpc-evil/Tun', '/vless-grpc', '/vless-grpc%2fTun']) {
      assert.equal((await http2Request(grpcPort, path)).headers[':status'], 404);
    }
    assert.equal((await fetch(`http://127.0.0.1:${wsPort}/unknown`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${wsPort}/vless`)).status, 426);
  });

  await t.test('large streams cross HTTP2 flow-control windows without truncation', async () => {
    const session = connect(`http://127.0.0.1:${grpcPort}`);
    try {
      const stream = session.request({
        ':method': 'POST',
        ':path': '/vless-grpc/TunLarge',
        'content-type': 'application/grpc',
      });
      const payload = Buffer.alloc(1024 * 1024, 0xab);
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      const ended = once(stream, 'end');
      stream.end(payload);
      await ended;
      assert.deepEqual(Buffer.concat(chunks), payload);
    } finally {
      session.destroy();
    }
  });

  await t.test('gRPC application failures retain their nonzero status trailers', async () => {
    const result = await http2Request(grpcPort, '/vless-grpc/Status');
    assert.equal(result.headers[':status'], 200);
    assert.equal(result.trailers['grpc-status'], '13');
  });

  await t.test('downstream cancellation closes the upstream tunnel', async () => {
    const session = connect(`http://127.0.0.1:${grpcPort}`);
    try {
      const stream = session.request({ ':method': 'POST', ':path': '/vmess-grpc/Cancel' });
      const received = once(stream, 'data');
      stream.write('open-tunnel');
      await received;
      const record = observed.get('/vmess-grpc/Cancel');
      stream.close(constants.NGHTTP2_CANCEL);
      await record.closed;
    } finally {
      session.destroy();
    }
    assert.equal((await http2Request(grpcPort, '/healthz')).headers[':status'], 200);
  });

  await t.test('upstream resets fail the downstream stream without crashing the gateway', async () => {
    await assert.rejects(http2Request(grpcPort, '/trojan-grpc/Reset'), /NGHTTP2_INTERNAL_ERROR/);
    assert.equal((await http2Request(grpcPort, '/healthz')).headers[':status'], 200);
    assert.match(logs, /Gateway gRPC proxy error/);
  });

  await t.test('unreachable upstreams return 502 and leave both listeners healthy', async () => {
    await new Promise(resolve => grpcServers.get('shadowsocks').close(resolve));
    const result = await http2Request(grpcPort, '/shadowsocks-grpc/Tun');
    assert.equal(result.headers[':status'], 502);
    assert.equal(result.body, 'Bad Gateway\n');
    await run(process.execPath, [healthcheckPath], { env });
  });

  await t.test('deployment health check fails if either listener is unreachable', async () => {
    for (const variable of ['GATEWAY_PORT', 'GATEWAY_GRPC_PORT']) {
      await assert.rejects(
        run(process.execPath, [healthcheckPath], { env: { ...env, [variable]: String(await freePort()) } }),
        error => error.code === 1 && /Gateway health check failed/.test(error.stderr),
      );
    }
  });

  await t.test('proxy traffic does not use deprecated util._extend', () => {
    assert.doesNotMatch(logs, /DEP0060|util\._extend/);
  });

  await t.test('connection logs use Cloudflare identity only when explicitly trusted', () => {
    const allRecords = logs.trim().split(/\r?\n/);
    for (const record of allRecords) {
      assert.match(record, /^\[\d{2}:\d{2}:\d{2}\] (INFO|WARN|ERROR): /);
      assert.doesNotMatch(record, /"level"|"service"|"ipSource"|\u001b/);
    }
    const startup = allRecords.filter(record => record.includes('gateway listening on port'));
    assert.equal(startup.length, 2);
    assert.ok(startup.every(record => record.includes('INFO:')));
    const errors = allRecords.filter(record => record.includes('ERROR:'));
    assert.ok(errors.length > 0);
    assert.ok(errors.some(record => record.includes('ECONNREFUSED')));
    const records = allRecords.filter(record => record.includes(' | IP='));
    for (const protocol of protocols) {
      for (const transport of ['ws', 'grpc']) {
        const prefix = `INFO: ${transport.toUpperCase()} ${protocol} | IP=`;
        const record = records.find(value => value.includes(prefix));
        assert.ok(record, `Missing ${protocol} ${transport} connection log`);
        const ip = trustCloudflareHeaders
          ? (transport === 'ws' ? '203.0.113.42' : '2001:db8::42') : '127.0.0.1';
        const country = trustCloudflareHeaders ? (transport === 'ws' ? 'US' : 'DE') : 'unknown';
        assert.ok(record.endsWith(`${prefix}${ip} | country=${country}`));
      }
    }
    const direct = records.find(value => value.includes('GRPC ') && value.endsWith('IP=127.0.0.1 | country=unknown'));
    assert.ok(direct, 'Missing socket fallback for requests without Cloudflare headers');
    assert.equal(records.filter(value => value.includes('INFO: WS ')).length, protocols.length);
  });

  await t.test('invalid Cloudflare metadata is ignored without interrupting traffic', async () => {
    const offset = logs.length;
    for (const headers of [
      { 'cf-connecting-ip': 'invalid-ip', 'cf-ipcountry': 'US' },
      { 'cf-connecting-ip': '203.0.113.42', 'cf-ipcountry': 'invalid-country' },
    ]) {
      assert.equal((await http2Request(grpcPort, '/vless-grpc/Metadata', headers)).headers[':status'], 200);
    }
    await run(process.execPath, [healthcheckPath], { env });
    const metadataLogs = logs.slice(offset);
    const allRecords = metadataLogs.trim().split(/\r?\n/);
    const records = allRecords.filter(record => record.includes(' | IP='));
    assert.equal(records.length, 2);
    assert.ok(records[0].endsWith('IP=127.0.0.1 | country=unknown'));
    assert.ok(records[1].endsWith(`IP=${trustCloudflareHeaders ? '203.0.113.42' : '127.0.0.1'} | country=unknown`));
    if (trustCloudflareHeaders) {
      assert.equal(allRecords.filter(record => record.includes('WARN:')).length, 2);
      assert.match(metadataLogs, /invalid CF-Connecting-IP ignored/);
      assert.match(metadataLogs, /invalid CF-IPCountry ignored/);
    } else {
      assert.doesNotMatch(metadataLogs, /Gateway connection metadata/);
    }
  });

  await t.test('status tracks completed attempts and transport failures without client metadata', async () => {
    const status = await statusSnapshot();
    assert.equal(status.totals.active, 0);
    for (const protocol of protocols) {
      const ws = status.connections.find(row => row.transport === 'ws' && row.protocol === protocol);
      assert.deepEqual(ws, { transport: 'ws', protocol, active: 0, total: 1, errors: 0 });
    }
    assert.equal(status.connections.find(row => row.transport === 'grpc' && row.protocol === 'trojan').errors, 1);
    assert.equal(status.connections.find(row => row.transport === 'grpc' && row.protocol === 'shadowsocks').errors, 1);
    assert.equal(status.totals.errors, 2);
    assert.equal(status.totals.total, 15);
    assert.doesNotMatch(JSON.stringify(status), /203\.0\.113|2001:db8|127\.0\.0|cf-|password|metadata|Tun/);
    const h2 = await http2Request(grpcPort, '/status.json', { ':method': 'GET' });
    assert.deepEqual(JSON.parse(h2.body).totals, status.totals);
  });
}

for (const trustCloudflareHeaders of [false, true]) {
  test(`gateway proxies WS and gRPC (trust Cloudflare headers: ${trustCloudflareHeaders})`,
    { timeout: 30000 }, t => testGateway(t, trustCloudflareHeaders));
}
