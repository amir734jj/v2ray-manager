import { useEffect, useState } from 'preact/hooks';
import prettyBytes from 'pretty-bytes';
import { errorMessage } from '../api.js';
import Table from './Table.jsx';

function eventLabel(event) {
  if (event.type === 'rejected') return `Upgrade rejected (HTTP ${event.statusCode})`;
  if (event.gatewayReason) return 'Gateway closed tunnel';
  if (event.socketError) return `${event.socketError.side === 'upstream' ? 'Upstream' : 'Client-facing'} socket error`;
  if (event.statusCode !== null && event.statusCode !== 101) return `Upstream rejected upgrade (HTTP ${event.statusCode})`;
  if (event.hadError) return 'Socket closed with an error';
  return 'Socket closed (cause not established)';
}

function Timestamp({ value }) {
  return value ? <time dateTime={value}>{value}</time> : 'Not observed';
}

function Bytes({ value }) {
  return value === null ? 'Not observed' : prettyBytes(value, { binary: true });
}

export default function TunnelDiagnostics({ status, connections, lastUpdatedAt, stale }) {
  const [subscription, setSubscription] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  useEffect(() => setCopied(false), [lastUpdatedAt, subscription, stale, status.diagnostics?.enabled]);
  const diagnostics = status.diagnostics;
  const names = new Map(connections.map(connection => [connection.id, connection.name]));
  for (const event of diagnostics?.recentEvents ?? []) {
    if (event.tunnelId && !names.has(event.tunnelId)) names.set(event.tunnelId, event.subscriptionName ?? event.tunnelId);
  }
  const events = (diagnostics?.recentEvents ?? []).filter(event => !subscription || event.tunnelId === subscription);

  async function copy() {
    setCopied(false);
    setCopyError('');
    const report = {
      capturedAt: new Date().toISOString(),
      lastDashboardUpdateAt: lastUpdatedAt,
      dashboardDataStale: stale,
      subscriptionId: subscription || null,
      gateway: {
        startedAt: status.startedAt,
        uptimeSeconds: status.uptimeSeconds,
        totals: status.totals,
        resources: status.resources,
        traffic: status.traffic,
      },
      diagnostics: {
        enabled: diagnostics.enabled,
        eventLimit: diagnostics.eventLimit,
        lastEventLoopDelay: diagnostics.lastEventLoopDelay,
        recentEvents: events,
      },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
    } catch (error) {
      setCopyError(`Could not copy diagnostics: ${errorMessage(error)}`);
    }
  }

  return <section class="card mb-4" aria-labelledby="tunnel-diagnostics">
    <div class="card-body">
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <h2 class="h4 mb-0" id="tunnel-diagnostics">Tunnel diagnostics</h2>
        <span class={`badge ${stale ? 'text-bg-warning' : diagnostics?.enabled ? 'text-bg-primary' : 'text-bg-secondary'}`}>
          {stale ? 'Snapshot stale / awaiting update' : diagnostics?.enabled ? 'Recording events' : diagnostics ? 'Recording disabled' : 'Unavailable'}
        </span>
      </div>
      <p class="small text-body-secondary">
        Last dashboard update (UTC): <Timestamp value={lastUpdatedAt} />.
        {' '}A dashboard reconnect is not proof of a tunnel disconnect.
      </p>
      {!diagnostics && <div class="alert alert-warning" role="alert">The gateway did not provide diagnostics. Deploy the updated gateway to enable this panel.</div>}
      {diagnostics && <>
        {!diagnostics.enabled && <div class="alert alert-info">
          Set <code>GATEWAY_TUNNEL_DIAGNOSTICS=true</code> on the gateway deployment to capture incidents.
        </div>}
        <p class="small text-body-secondary">
          Latest {diagnostics.eventLimit} closures/rejections, kept only in gateway memory and cleared on restart.
          {' '}Ordinary closures are not necessarily failures. Client-facing means the gateway socket toward Coolify or a direct client;
          {' '}the first observed closing side is evidence, not a definitive root cause.
        </p>
        {diagnostics.lastEventLoopDelay && <p class="small">
          Last observed gateway event-loop delay: <strong>{diagnostics.lastEventLoopDelay.lagMs.toFixed(1)} ms</strong>
          {' '}at <Timestamp value={diagnostics.lastEventLoopDelay.observedAt} />.
          {' '}This is a historical observation, not a current health verdict.
        </p>}
        <div class="d-flex flex-column flex-sm-row align-items-sm-end gap-2 mb-3">
          <div class="flex-grow-1">
            <label class="form-label" for="diagnostic-subscription">Filter subscription</label>
            <select id="diagnostic-subscription" class="form-select" value={subscription}
              onChange={event => setSubscription(event.currentTarget.value)}>
              <option value="">All subscriptions / unassigned attempts</option>
              {[...names].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          <button class="btn btn-outline-secondary flex-shrink-0" onClick={copy}>
            {copied ? 'Copied report' : 'Copy diagnostic report'}
          </button>
        </div>
        {copyError && <div class="alert alert-danger" role="alert">{copyError}</div>}
        <Table headings={['Observed (UTC)', 'Subscription / IP', 'Protocol', 'Event details']}>
          {events.map((event, index) => <tr key={`${event.connectionId}:${event.type}:${event.observedAt}:${index}`}>
            <td class="small text-nowrap"><Timestamp value={event.observedAt} /></td>
            <td class="text-break">{event.subscriptionName ?? 'Unassigned attempt'}<div><code>{event.ip ?? 'IP unavailable'}</code></div></td>
            <td>{event.protocol ?? 'Unknown'}</td>
            <td><details>
              <summary><span class={`badge ${event.severity === 'warning' ? 'text-bg-warning' : 'text-bg-secondary'}`}>{eventLabel(event)}</span></summary>
              <dl class="small mt-2 mb-0">
                <dt>Connection ID</dt><dd class="text-break">{event.connectionId ?? 'Not assigned'}</dd>
                <dt>Gateway reason</dt><dd>{event.gatewayReason ?? 'Not observed'}</dd>
                <dt>First observed close</dt><dd>{event.firstObservedClose ? `${event.firstObservedClose.side}: ${event.firstObservedClose.event}` : 'Not observed'}</dd>
                <dt>Socket error</dt><dd>{event.socketError
                  ? `${event.socketError.side}: ${event.socketError.code}${event.socketError.syscall ? ` (${event.socketError.syscall})` : ''}`
                  : event.hadError ? 'Socket reported an error without a captured code' : 'No socket error captured'}</dd>
                <dt>Upgrade HTTP status</dt><dd>{event.statusCode ?? 'Not observed'}</dd>
                <dt>Upstream handshake / tunnel duration</dt><dd>
                  {event.handshakeMs === null ? 'Not observed' : `${event.handshakeMs.toFixed(1)} ms`}
                  {' / '}{event.durationMs === null ? 'Not observed' : `${(event.durationMs / 1000).toFixed(1)} s`}
                </dd>
                <dt>Socket upload / download</dt><dd><Bytes value={event.uploadBytes} /> / <Bytes value={event.downloadBytes} /></dd>
                <dt>Upstream socket upload / download</dt><dd><Bytes value={event.upstreamUploadBytes} /> / <Bytes value={event.upstreamDownloadBytes} /></dd>
                <dt>Immediate peer / upstream</dt><dd class="text-break">{event.socketPeerIp ?? 'Not observed'}
                  {' / '}{event.upstreamAddress ? `${event.upstreamAddress}:${event.upstreamPort}` : 'Not observed'}</dd>
                {event.maxConcurrentIps !== null && <><dt>Observed active IPs / limit</dt><dd>{event.activeIpCount ?? 'Unknown'} / {event.maxConcurrentIps}</dd></>}
              </dl>
            </details></td>
          </tr>)}
          {!events.length && <tr><td colSpan={4}>{stale ? 'No matching events in the last received snapshot.'
            : diagnostics.enabled ? 'No matching events captured. This does not establish that browsing is healthy.'
              : 'Incident recording is disabled.'}</td></tr>}
        </Table>
        <p class="small text-body-secondary mb-0">Reports exclude credentials, subscription URLs, cookies, and payloads, but include IPs and subscription names. Share only with trusted support.</p>
      </>}
    </div>
  </section>;
}
