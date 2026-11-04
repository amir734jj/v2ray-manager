import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { Writable } from 'node:stream';
import test from 'node:test';
import httpProxy from 'http-proxy-3';
import { createGatewayLogger } from '../gateway/logger.mjs';
import { logUpstreamTraffic } from '../gateway/upstream-traffic.mjs';

test('logs are single-line JSON, including stacks and multiline client input', () => {
  let output = '';
  const logger = createGatewayLogger(new Writable({
    write(chunk, _encoding, callback) {
      output += chunk;
      callback();
    },
  }));
  logger.info({ userAgent: 'first\nsecond', headers: { cookie: 'secret' } }, 'Gateway proxy request');
  logger.error({ err: new Error('first\nsecond') }, 'Gateway proxy error');
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 2);
  const [request, failure] = lines.map(line => JSON.parse(line));
  assert.equal(request.userAgent, 'first\nsecond');
  assert.equal(request.headers.cookie, '[REDACTED]');
  assert.match(failure.err.stack, /Error: first\nsecond/);
});

test('periodic upstream logs include failed attempts and stop cleanly', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const proxy = new EventEmitter();
  const logs = [];
  const stop = logUpstreamTraffic(proxy, { info: (data, message) => logs.push({ data, message }) });
  const request = new EventEmitter();
  const socket = Object.assign(new EventEmitter(), { bytesRead: 0, bytesWritten: 0 });
  proxy.emit('proxyReqWs', request);
  request.emit('socket', socket);
  socket.bytesRead = 120;
  socket.bytesWritten = 250;
  socket.emit('close');
  t.mock.timers.tick(5000);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, 'Gateway upstream throughput');
  assert.equal(logs[0].data.gatewayToV2rayBytes, 250);
  assert.equal(logs[0].data.v2rayToGatewayBytes, 120);
  assert.ok(logs[0].data.intervalSeconds > 0);
  assert.ok(Number.isFinite(logs[0].data.gatewayToV2rayMbps));
  t.mock.timers.tick(5000);
  assert.equal(logs[1].data.gatewayToV2rayMbps, 0);
  assert.equal(logs[1].data.v2rayToGatewayMbps, 0);
  stop();
  t.mock.timers.tick(5000);
  assert.equal(logs.length, 2);
  assert.equal(proxy.listenerCount('proxyReqWs'), 0);
});

function readUntil(socket, complete) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      if (complete(data)) {
        cleanup();
        resolve(data);
      }
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error('Socket closed before expected data arrived'));
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

test('real WebSocket proxy measures upstream bytes without changing forwarded data', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let upstreamSocket;
  const upstream = createServer();
  const gateway = createServer();
  const proxy = httpProxy.createProxyServer({ ws: true });
  const logs = [];
  const stop = logUpstreamTraffic(proxy, { info: data => logs.push(data) });
  let client;
  t.after(() => {
    stop();
    client?.destroy();
    upstreamSocket?.destroy();
    upstream.close();
    gateway.close();
    proxy.close();
  });
  upstream.on('upgrade', (_request, socket) => {
    upstreamSocket = socket;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', chunk => socket.write(chunk));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const target = `http://127.0.0.1:${upstream.address().port}`;
  gateway.on('upgrade', (request, socket, head) => proxy.ws(request, socket, head, { target }));
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  client = createConnection({ port: gateway.address().port, host: '127.0.0.1' });
  await once(client, 'connect');
  const handshake = readUntil(client, data => data.includes('\r\n\r\n'));
  client.write('GET /vless HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  assert.match((await handshake).toString(), /^HTTP\/1.1 101/);
  const payload = Buffer.alloc(256 * 1024, 42);
  const echoed = readUntil(client, data => data.length >= payload.length);
  client.write(payload);
  assert.deepEqual(await echoed, payload);
  const expectedUpload = upstreamSocket.bytesRead;
  const expectedDownload = upstreamSocket.bytesWritten;
  t.mock.timers.tick(5000);
  assert.equal(logs[0].gatewayToV2rayBytes, expectedUpload);
  assert.equal(logs[0].v2rayToGatewayBytes, expectedDownload);
  assert.ok(expectedUpload > payload.length, 'upstream request handshake is counted');
  assert.ok(expectedDownload > payload.length, 'upstream response handshake is counted');
  const closed = once(upstreamSocket, 'close');
  client.end();
  await closed;
  t.mock.timers.tick(5000);
  assert.equal(logs[1].gatewayToV2rayBytes, expectedUpload);
  assert.equal(logs[1].v2rayToGatewayBytes, expectedDownload);
  assert.equal(logs[1].gatewayToV2rayMbps, 0);
  assert.equal(logs[1].v2rayToGatewayMbps, 0);
});
