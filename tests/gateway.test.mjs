import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createHttp2Server, connect, constants } from 'node:http2';
import { createServer as createTcpServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { protocols } from '../generator/connections.mjs';

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

async function http2Request(port, path) {
  const session = connect(`http://127.0.0.1:${port}`);
  try {
    return await new Promise((resolve, reject) => {
      session.once('error', reject);
      const stream = session.request({ ':path': path, ':method': 'POST' });
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

test('gateway proxies WebSocket and HTTP2 gRPC through separate listeners', { timeout: 30000 }, async t => {
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

  gateway = spawn(process.execPath, [gatewayPath], { env, windowsHide: true });
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
          headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
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
});
