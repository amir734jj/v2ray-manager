import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createTrafficMeter } from '../gateway/traffic.mjs';

function socket(bytesRead = 0, bytesWritten = 0) {
  return Object.assign(new EventEmitter(), { bytesRead, bytesWritten });
}

test('client meter preserves buffered upload bytes and five-second rates', () => {
  let time = 0;
  const traffic = createTrafficMeter({ now: () => time });
  const client = socket(100, 50);
  traffic.track(client, 20);
  assert.equal(traffic.snapshot().intervalSeconds, null);
  client.bytesRead += 1000;
  client.bytesWritten += 2000;
  time = 5000;
  traffic.sample();
  assert.deepEqual(traffic.snapshot(), {
    uploadBytes: 1020, downloadBytes: 2000, intervalSeconds: 5,
    uploadBytesPerSecond: 204, downloadBytesPerSecond: 400,
  });
});

test('upstream meter measures writes as upload and reads as download', () => {
  let time = 0;
  const traffic = createTrafficMeter({ now: () => time, upstream: true });
  const upstream = socket(100, 50);
  traffic.track(upstream, 20);
  upstream.bytesRead += 2000;
  upstream.bytesWritten += 1000;
  time = 5000;
  traffic.sample();
  assert.deepEqual(traffic.snapshot(), {
    uploadBytes: 1000, downloadBytes: 2020, intervalSeconds: 5,
    uploadBytesPerSecond: 200, downloadBytesPerSecond: 404,
  });
  assert.equal(upstream.listenerCount('data'), 0);
});

test('closed upstream sockets contribute once, including between samples', () => {
  let time = 0;
  const traffic = createTrafficMeter({ now: () => time, upstream: true });
  const first = socket();
  const second = socket();
  traffic.track(first);
  traffic.track(second);
  first.bytesRead = 500;
  first.bytesWritten = 1000;
  first.emit('close');
  first.emit('close');
  second.bytesRead = 1500;
  second.bytesWritten = 2000;
  time = 6000;
  traffic.sample();
  assert.deepEqual(traffic.snapshot(), {
    uploadBytes: 3000, downloadBytes: 2000, intervalSeconds: 6,
    uploadBytesPerSecond: 500, downloadBytesPerSecond: 2000 / 6,
  });
  second.emit('close');
  time = 11000;
  traffic.sample();
  assert.deepEqual(traffic.snapshot(), {
    uploadBytes: 3000, downloadBytes: 2000, intervalSeconds: 5,
    uploadBytesPerSecond: 0, downloadBytesPerSecond: 0,
  });
});

test('zero elapsed time leaves rates uninitialized', () => {
  const traffic = createTrafficMeter({ now: () => 0, upstream: true });
  traffic.sample();
  assert.deepEqual(traffic.snapshot(), {
    uploadBytes: 0, downloadBytes: 0, intervalSeconds: null,
    uploadBytesPerSecond: null, downloadBytesPerSecond: null,
  });
});
