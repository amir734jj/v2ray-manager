import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { Link } from 'preact-router/match';
import prettyBytes from 'pretty-bytes';
import { api, errorMessage } from '../api.js';
import Table from '../components/Table.jsx';
import ResourceCharts from '../components/ResourceCharts.jsx';
import { useResource } from '../useResource.js';

function Rate({ value }) {
  if (value === null) return 'Collecting...';
  return `${prettyBytes(value, { binary: true })}/s`;
}

function Counters({ rows, countries = false }) {
  return <Table headings={[countries ? 'Country' : 'Protocol', countries ? 'Code' : 'Transport', 'Open client sockets', 'Connection attempts', 'Proxy failures']}>
    {rows.map(row => <tr key={countries ? row.code : row.protocol}>
      <th scope="row">{countries ? row.name : row.protocol}</th>
      <td>{countries ? row.code : row.transport.toUpperCase()}</td>
      <td>{row.active}</td><td>{row.total}</td><td>{row.errors}</td>
    </tr>)}
    {!rows.length && <tr><td colSpan={5}>No connections yet.</td></tr>}
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

export default function Status({ user }) {
  const { data: status, error: refreshError, loading, refresh } = useResource('/api/status.json');
  const [expandedIp, setExpandedIp] = useState(new URLSearchParams(location.search).get('client'));
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
      <Table headings={['IP address', 'Location', 'ISP / Network', 'Protocols', status.clientDetails.omitted ? 'Displayed sockets' : 'Open client sockets', 'Upload', 'Download', 'Details', ...(user.admin && status.blocklistAvailable ? ['Actions'] : [])]}>
        {status.clientGroups.map(group => <Fragment key={group.ip}>
          <tr>
            <th scope="row">{group.ip}</th>
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
          {expandedIp === group.ip && <tr><td colSpan={user.admin && status.blocklistAvailable ? 9 : 8}>
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
            <Table headings={['Connection ID', 'Protocol', 'Country', 'Upload', 'Download', 'Reported client (User-Agent)', 'Connected since (UTC)', 'Open for (seconds)']}>
              {status.clients.filter(client => client.ip === group.ip).map(client => <tr key={client.connectionId}>
                <th scope="row" class="text-break">{client.connectionId}</th><td>{client.protocol}</td>
                <td>{client.countryName} ({client.countryCode})</td>
                <td class="text-nowrap"><Rate value={client.traffic.uploadBytesPerSecond} /></td>
                <td class="text-nowrap"><Rate value={client.traffic.downloadBytesPerSecond} /></td>
                <td class="text-break">{client.userAgent}</td>
                <td>{client.connectedAt}</td><td>{client.elapsedSeconds}</td>
              </tr>)}
            </Table>
          </td></tr>}
        </Fragment>)}
        {!status.clientGroups.length && <tr><td colSpan={user.admin && status.blocklistAvailable ? 9 : 8}>No active client connections.</td></tr>}
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
