import { parentPort } from 'node:worker_threads';
import lodash from 'lodash';
import Table from 'cli-table3';

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

parentPort.on('message', ({ groups, protocols, subscriptionCount, ipCount }) => {
  const rows = lodash.sortBy(groups, ['subscription', 'ip']);
  const pendingRate = (group, value) => group.sampled === 0 ? 'collecting'
    : `${formatRate(value)}${group.sampled < group.tunnels ? ` (+${group.tunnels - group.sampled} pending)` : ''}`;
  const interval = protocols[0]?.intervalSeconds;
  parentPort.postMessage([
    `Gateway connection snapshot (sample: ${interval == null ? 'collecting' : `${interval.toFixed(2)}s`})`,
    `Connected: ${subscriptionCount} subscriptions | ${ipCount} client IPs | ${lodash.sumBy(rows, 'tunnels')} tunnels`,
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
});
