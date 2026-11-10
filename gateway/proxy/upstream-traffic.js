import lodash from 'lodash';
import { Worker } from 'node:worker_threads';
import { createTrafficMeter } from '../services/traffic.js';
import { formatLogText } from '../services/logger.js';

export function logUpstreamTraffic(proxy, logger, paths, { tunnelSockets, wsConnections }) {
  const meters = new Map(lodash.map([...paths], path => [path, createTrafficMeter({ upstream: true })]));
  const measurements = new WeakMap();
  let worker = null;
  let formatting = false;
  let pendingSnapshot = null;
  let lagging = false;
  let stopped = false;

  function workerFailed(instance, error) {
    if (worker !== instance) return;
    worker = null;
    formatting = false;
    pendingSnapshot = null;
    logger.error({ err: error }, 'Connection snapshot formatter failed; retrying on the next sample');
  }

  function format(snapshot) {
    if (formatting) {
      if (pendingSnapshot && !lagging) {
        logger.warn('Connection snapshot formatter is behind; intermediate snapshots are being coalesced');
        lagging = true;
      }
      pendingSnapshot = snapshot;
      return;
    }
    try {
      if (!worker) {
        const instance = new Worker(new URL('./traffic-snapshot-worker.js', import.meta.url));
        worker = instance;
        instance.on('message', message => {
          if (worker !== instance || stopped) return;
          formatting = false;
          logger.info(message);
          const next = pendingSnapshot;
          pendingSnapshot = null;
          if (next) format(next);
          else lagging = false;
        });
        instance.on('error', error => workerFailed(instance, error));
        instance.on('exit', code => {
          if (!stopped) workerFailed(instance, new Error(`Snapshot formatter exited with code ${code}`));
        });
        instance.unref();
      }
      formatting = true;
      worker.postMessage(snapshot);
    } catch (error) {
      const instance = worker;
      workerFailed(instance, error);
      instance?.terminate().catch(err => logger.error({ err }, 'Snapshot formatter shutdown failed'));
    }
  }
  const onRequest = (request, incomingRequest) => {
    const traffic = meters.get(incomingRequest.url);
    if (!traffic) throw new Error('Unknown upstream traffic route');
    // Measure before the handshake is written, including failed upstream attempts.
    request.once('socket', socket => {
      const measurement = traffic.track(socket, 0, true);
      const connection = wsConnections.get(incomingRequest);
      if (connection) measurements.set(connection, measurement);
    });
  };
  proxy.on('proxyReqWs', onRequest);
  const timer = setInterval(() => {
    const protocols = [];
    for (const [path, traffic] of meters) {
      traffic.sample();
      protocols.push({ protocol: path.slice(1), tunnels: 0, ...traffic.snapshot() });
    }
    const groups = new Map();
    const subscriptions = new Set();
    const ips = new Set();
    for (const [id, sockets] of tunnelSockets) {
      for (const [socket, connection] of sockets) {
        if (socket.destroyed || connection.blocked) continue;
        const { ip, protocol, subscriptionName } = connection.client;
        const key = `${id}:${ip}`;
        if (!groups.has(key)) {
          groups.set(key, {
            subscription: subscriptionName ? formatLogText(subscriptionName) : 'Unnamed subscription',
            ip: ip ?? 'unknown', protocols: new Set(), tunnels: 0, sampled: 0, upload: 0, download: 0,
          });
        }
        const group = groups.get(key);
        group.protocols.add(protocol);
        group.tunnels++;
        subscriptions.add(id);
        if (ip) ips.add(ip);
        const stats = protocols.find(row => row.protocol === protocol);
        if (stats) stats.tunnels++;
        const measurement = measurements.get(connection)?.snapshot();
        if (measurement?.intervalSeconds != null) {
          group.sampled++;
          group.upload += measurement.uploadBytesPerSecond;
          group.download += measurement.downloadBytesPerSecond;
        }
      }
    }
    format({ groups: [...groups.values()], protocols, subscriptionCount: subscriptions.size, ipCount: ips.size });
  }, 60000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    proxy.off('proxyReqWs', onRequest);
    pendingSnapshot = null;
    const instance = worker;
    worker = null;
    return instance?.terminate().catch(err => logger.error({ err }, 'Snapshot formatter shutdown failed'));
  };
}
