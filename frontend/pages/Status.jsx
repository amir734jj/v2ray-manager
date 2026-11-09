import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { Link } from 'preact-router/match';
import prettyBytes from 'pretty-bytes';
import { api, errorMessage } from '../api.js';
import Table from '../components/Table.jsx';
import ResourceCharts from '../components/ResourceCharts.jsx';
import Rate from '../components/TrafficRate.jsx';
import { useResource } from '../useResource.js';

function Counters({ rows, countries = false }) {
  const visibleRows = rows.filter(row => row.active !== 0 || row.total !== 0 || row.errors !== 0);
  return <Table headings={[countries ? 'Country' : 'Protocol', countries ? 'Code' : 'Transport', 'Open client sockets', 'Connection attempts', 'Proxy failures']}>
    {visibleRows.map(row => <tr key={countries ? row.code : row.protocol}>
      <th scope="row">{countries ? row.name : row.protocol}</th>
      <td>{countries ? row.code : row.transport.toUpperCase()}</td>
      <td>{row.active}</td><td>{row.total}</td><td>{row.errors}</td>
    </tr>)}
    {!visibleRows.length && <tr><td colSpan={5}>No connections yet.</td></tr>}
  </Table>;
}

function IpLocation({ details, countries }) {
  if (details?.status === 'ready') {
    return <>{[details.city, details.region, details.country].filter(Boolean).join(', ') || 'Unknown'}</>;
  }
  const messages = {
    loading: 'Looking up...',
    'not-public': 'Not a public IP',
    'rate-limited': 'Lookup rate limited; retrying later',
  };
  return <>
    {countries.filter(country => country.code !== 'unknown').map(country => `${country.name} (${country.code})`).join(', ')}
    <div class="small text-body-secondary">{messages[details?.status] || 'Lookup unavailable; retrying later'}</div>
  </>;
}

function OnlineSubscriptions({ resource }) {
  const { data, error, loading } = resource;
  const online = data ? data.connections.filter(connection => connection.gateway.openTunnels > 0) : [];

  return <section class="mb-4" aria-labelledby="online-subscriptions">
    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
      <h2 class="h4" id="online-subscriptions">Online subscriptions</h2>
      <Link href="/subscriptions">Manage subscriptions</Link>
    </div>
    <p class="text-body-secondary">
      Online means at least one gateway tunnel is open, not proof that browsing works.
      Connections update live; throughput is sampled every 5 seconds.
    </p>
    {error && <div class="alert alert-danger" role="alert">Subscription status: {error}</div>}
    {data?.tunnelError && <div class="alert alert-warning" role="alert">{data.tunnelError}</div>}
    {loading && <p role="status">Loading online subscriptions...</p>}
    {data && <Table headings={['Subscription', 'Status', 'Connected IPs', 'Open tunnels', 'Upload', 'Download', 'Connected since']}>
      {online.map(connection => <tr key={connection.id}>
        <th scope="row">
          <div class="text-break">{connection.name}</div>
          <code class="small text-body-secondary">{connection.id.slice(0, 8)}</code>
        </th>
        <td><span class={`badge ${error ? 'text-bg-secondary' : 'text-bg-success'}`}>
          {error ? 'Unknown (stale)' : 'Online'}
        </span></td>
        <td>{connection.connectedIps.map(ip => <div key={ip}><code class="text-break">{ip}</code></div>)}</td>
        <td>{connection.gateway.openTunnels}</td>
        <td class="text-nowrap"><Rate value={connection.gateway.traffic.uploadBytesPerSecond} /></td>
        <td class="text-nowrap"><Rate value={connection.gateway.traffic.downloadBytesPerSecond} /></td>
        <td>{connection.gateway.connectedSince
          ? <time dateTime={connection.gateway.connectedSince}>{new Date(connection.gateway.connectedSince).toLocaleString()}</time>
          : 'Unknown'}</td>
      </tr>)}
      {!online.length && <tr><td colSpan={7}>
        {error ? 'No online subscriptions in the last received snapshot.' : 'No subscriptions currently online.'}
      </td></tr>}
    </Table>}
  </section>;
}

function SubscriptionNames({ connections, resource }) {
  if (!resource.data) return <span class="text-body-secondary">{resource.loading ? 'Loading...' : 'Unavailable'}</span>;
  const stale = resource.error || resource.data.tunnelError;
  return <>
    {connections.length ? connections.map(connection => <div key={connection.id} class="text-break">
      {connection.name} <code class="small text-body-secondary">({connection.id.slice(0, 8)})</code>
    </div>) : <span class="text-body-secondary">{stale ? 'Unavailable' : 'Unknown'}</span>}
    {stale && connections.length > 0 && <div class="small text-body-secondary">Stale subscription details</div>}
  </>;
}

function StatusContent({ user, subscriptionResource }) {
  const { data: status, error: refreshError, loading, refresh } = useResource('/api/status.json');
  const [expandedIp, setExpandedIp] = useState(new URLSearchParams(location.search).get('client'));
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const subscriptionsByIp = new Map();
  const subscriptionsById = new Map();
  for (const connection of subscriptionResource?.data?.connections ?? []) {
    subscriptionsById.set(connection.id, connection);
    for (const ip of connection.connectedIps) {
      if (!subscriptionsByIp.has(ip)) subscriptionsByIp.set(ip, []);
      subscriptionsByIp.get(ip).push(connection);
    }
  }
  const clientColumns = 8 + (user.admin ? 1 : 0) + (user.admin && status?.blocklistAvailable ? 1 : 0);

  async function block(ip) {
    setBusy(true);
    setError('');
    try {
      await api.post('/api/blocklist/block', { ip });
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <h1>Gateway status</h1>
    <p class="text-body-secondary">Live connection counters - throughput and CPU usage are sampled every 5 seconds</p>
    {error && <div class="alert alert-danger" role="alert">{error}</div>}
    {refreshError && <div class="alert alert-danger" role="alert">{refreshError}</div>}
    {loading && <p role="status">Loading status...</p>}
    {status && <>
      <section class="row g-3 my-4" aria-label="Connection totals">
        {[['Open client sockets', status.totals.active], ['Connection attempts', status.totals.total], ['Proxy failures', status.totals.errors]].map(([label, value]) =>
          <div class="col-12 col-sm-4" key={label}><div class="card h-100"><div class="card-body">
            <p class="text-body-secondary">{label}</p><strong class="fs-2">{value}</strong>
          </div></div></div>)}
      </section>
      {user.admin && <OnlineSubscriptions resource={subscriptionResource} />}
      <h2 class="h4">Gateway process resources</h2>
      <p class="text-body-secondary">CPU averages the latest sampling interval; 100% is one CPU core and usage can exceed 100%. Memory is for the gateway process only, not the host, container total, or V2Ray.</p>
      <section class="row g-3 mb-4" aria-label="Gateway process resources">
        {[
          ['CPU usage', status.resources.cpuPercent === null ? 'Collecting...' : `${status.resources.cpuPercent.toFixed(1)}%`],
          ['Resident memory (RSS)', prettyBytes(status.resources.memory.rssBytes, { binary: true })],
          ['JavaScript heap used', prettyBytes(status.resources.memory.heapUsedBytes, { binary: true })],
          ['JavaScript heap allocated', prettyBytes(status.resources.memory.heapTotalBytes, { binary: true })],
        ].map(([label, value]) =>
          <div class="col-12 col-sm-6 col-lg-3" key={label}><div class="card h-100"><div class="card-body">
            <p>{label}</p><strong class="fs-2">{value}</strong>
          </div></div></div>)}
      </section>
      <h2 class="h4">Proxy throughput</h2>
      <p class="text-body-secondary">Average over the latest five-second sample, measured at the gateway socket.</p>
      <section class="row g-3 mb-4" aria-label="Proxy throughput">
        {[['Upload (client to proxy)', status.traffic.uploadBytesPerSecond], ['Download (proxy to client)', status.traffic.downloadBytesPerSecond]].map(([label, value]) =>
          <div class="col-12 col-sm-6" key={label}><div class="card"><div class="card-body">
            <p>{label}</p><strong class="fs-2"><Rate value={value} /></strong>
          </div></div></div>)}
      </section>
      <button class="btn btn-outline-secondary mb-4" aria-expanded={showHistory}
        aria-controls="resource-history" onClick={() => setShowHistory(visible => !visible)}>
        {showHistory ? 'Hide history graphs' : 'Show history graphs'}
      </button>
      <div id="resource-history" hidden={!showHistory}>
        {showHistory && <ResourceCharts />}
      </div>
      <Counters rows={status.connections} />
      <h2 class="h4 mt-4" id="active-clients">Active clients by IP</h2>
      {status.clientDetails.omitted > 0 && <div class="alert alert-warning" role="status">
        Showing details for {status.clientDetails.shown} of {status.totals.active} open sockets (limit {status.clientDetails.limit}).
        {' '}{status.clientDetails.omitted} sockets are omitted from IP groups; protocol and country totals still include every socket.
      </div>}
      <p class="text-body-secondary">One group per IP, not per person or device. Expand to see sockets. User-Agent may be missing or spoofed and does not reliably identify a device model.</p>
      {user.admin && <p class="text-body-secondary">Subscriptions lists every subscription currently using each IP. Expand a row to see the subscription associated with each connection.</p>}
      <Table headings={['IP address', ...(user.admin ? ['Subscriptions'] : []), 'Location', 'ISP / Network', 'Protocols', status.clientDetails.omitted ? 'Displayed sockets' : 'Open client sockets', 'Upload', 'Download', 'Details', ...(user.admin && status.blocklistAvailable ? ['Actions'] : [])]}>
        {status.clientGroups.map(group => <Fragment key={group.ip}>
          <tr>
            <th scope="row">{group.ip}</th>
            {user.admin && <td><SubscriptionNames connections={subscriptionsByIp.get(group.ip) ?? []}
              resource={subscriptionResource} /></td>}
            <td><IpLocation details={group.ipDetails} countries={group.countries} /></td>
            <td>{group.ipDetails?.status === 'ready'
              ? group.ipDetails.isp || group.ipDetails.organization || 'Unknown'
              : group.ipDetails?.status === 'loading' ? 'Looking up...' : 'Unavailable'}</td>
            <td>{group.protocols.join(', ')}</td>
            <td>{group.active}
              {group.traffic.sampledSockets < group.active && <div class="small text-body-secondary">
                {group.traffic.sampledSockets}/{group.active} sampled
              </div>}
            </td>
            <td class="text-nowrap"><Rate value={group.traffic.uploadBytesPerSecond} /></td>
            <td class="text-nowrap"><Rate value={group.traffic.downloadBytesPerSecond} /></td>
            <td><button class="btn btn-sm btn-outline-secondary text-nowrap" aria-expanded={expandedIp === group.ip}
              aria-label={`${expandedIp === group.ip ? 'Hide' : 'View'} connections for ${group.ip}`} onClick={() => {
              const ip = expandedIp === group.ip ? null : group.ip;
              setExpandedIp(ip);
              history.replaceState(null, '', `${location.pathname}${ip ? `?client=${encodeURIComponent(ip)}` : ''}#active-clients`);
            }}>{expandedIp === group.ip ? 'Hide' : 'View'}</button></td>
            {user.admin && status.blocklistAvailable && <td><button class="btn btn-sm btn-outline-danger text-nowrap" disabled={busy}
              onClick={() => block(group.ip)}>Block IP</button></td>}
          </tr>
          {expandedIp === group.ip && <tr><td colSpan={clientColumns}>
            {group.ipDetails?.status === 'ready' && <dl class="row mb-3">
              {[
                ['Organization', group.ipDetails.organization],
                ['Timezone', group.ipDetails.timezone],
                ['Postal code', group.ipDetails.postal],
                ['Approximate coordinates', group.ipDetails.latitude !== null && group.ipDetails.longitude !== null
                  ? `${group.ipDetails.latitude}, ${group.ipDetails.longitude}` : null],
              ].map(([label, value]) => <Fragment key={label}>
                <dt class="col-sm-3">{label}</dt><dd class="col-sm-9">{value || 'Unknown'}</dd>
              </Fragment>)}
            </dl>}
            <Table headings={['Connection ID', ...(user.admin ? ['Subscription'] : []), 'Protocol', 'Country', 'Upload', 'Download', 'Reported client (User-Agent)', 'Connected since (UTC)', 'Open for (seconds)']}>
              {status.clients.filter(client => client.ip === group.ip).map(client => <tr key={client.connectionId}>
                <th scope="row" class="text-break">{client.connectionId}</th>
                {user.admin && <td><SubscriptionNames
                  connections={subscriptionsById.has(client.subscriptionId) ? [subscriptionsById.get(client.subscriptionId)] : []}
                  resource={subscriptionResource} /></td>}
                <td>{client.protocol}</td>
                <td>{client.countryName} ({client.countryCode})</td>
                <td class="text-nowrap"><Rate value={client.traffic.uploadBytesPerSecond} /></td>
                <td class="text-nowrap"><Rate value={client.traffic.downloadBytesPerSecond} /></td>
                <td class="text-break">{client.userAgent}</td>
                <td>{client.connectedAt}</td><td>{client.elapsedSeconds}</td>
              </tr>)}
            </Table>
          </td></tr>}
        </Fragment>)}
        {!status.clientGroups.length && <tr><td colSpan={clientColumns}>No active client connections.</td></tr>}
      </Table>
      {status.blocklistAvailable && <p><Link href="/blocked-ips">View blocked IPs</Link></p>}
      <h2 class="h4 mt-4">Connections by country</h2>
      <p class="text-body-secondary">Based on trusted Cloudflare metadata; unavailable values appear as Unknown.</p>
      <Counters rows={status.countries} countries />
      <footer class="mt-4 small text-body-secondary">
        <p>Started {status.startedAt} - Uptime {status.uptimeSeconds}s - <a href="/api/status.json" data-native>JSON snapshot</a></p>
        <p>Counts reset on restart. Healthy listeners do not prove authenticated browsing works.</p>
      </footer>
    </>}
  </>;
}

function AdministratorStatus({ user }) {
  const subscriptionResource = useResource('/api/connections');
  return <StatusContent user={user} subscriptionResource={subscriptionResource} />;
}

export default function Status({ user }) {
  return user.admin ? <AdministratorStatus user={user} /> : <StatusContent user={user} />;
}
