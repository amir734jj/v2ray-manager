import lodash from 'lodash';
import Table from 'cli-table3';
import { createTrafficMeter } from '../services/traffic.js';
import { formatLogText } from '../services/logger.js';

function formatRate(bytesPerSecond) {
  return bytesPerSecond === null ? 'collecting' : `${(bytesPerSecond * 8 / 1e6).toFixed(3)} Mbps`;
}

function table(headings, rows) {
  const output = new Table({
    head: headings,
    chars: {
      top: '-', 'top-mid': '', 'top-left': '', 'top-right': '',
      bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      left: '', 'left-mid': '', mid: '-', 'mid-mid': '',
      right: '', 'right-mid': '', middle: '',
    },
    style: { head: [], border: [], compact: true, 'padding-left': 0, 'padding-right': 2 },
  });
  output.push(...rows);
  return output.toString();
}

export function logUpstreamTraffic(proxy, logger, paths, { tunnelSockets, wsConnections }) {
  const meters = new Map(lodash.map([...paths], path => [path, createTrafficMeter({ upstream: true })]));
  const measurements = new WeakMap();
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
    const rows = lodash.sortBy([...groups.values()], ['subscription', 'ip']);
    const pendingRate = (group, value) => group.sampled === 0 ? 'collecting'
      : `${formatRate(value)}${group.sampled < group.tunnels ? ` (+${group.tunnels - group.sampled} pending)` : ''}`;
    const interval = protocols[0]?.intervalSeconds;
    logger.info([
      `Gateway connection snapshot (sample: ${interval == null ? 'collecting' : `${interval.toFixed(2)}s`})`,
      `Connected: ${subscriptions.size} subscriptions | ${ips.size} client IPs | ${lodash.sumBy(rows, 'tunnels')} tunnels`,
      rows.length ? table(['Subscription', 'Client IP', 'Protocols', 'Tunnels', 'Upload', 'Download'],
        rows.map(group => [
          group.subscription, group.ip, [...group.protocols].sort().join(', '), String(group.tunnels),
          pendingRate(group, group.upload), pendingRate(group, group.download),
        ])) : 'No clients connected.',
      'Protocol totals (including traffic from connections closed during this interval):',
      table(['Protocol', 'Tunnels', 'Upload', 'Download'], protocols.map(row => [
        row.protocol, String(row.tunnels), formatRate(row.uploadBytesPerSecond), formatRate(row.downloadBytesPerSecond),
      ])),
      '',
    ].join('\n'));
  }, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    proxy.off('proxyReqWs', onRequest);
  };
}
