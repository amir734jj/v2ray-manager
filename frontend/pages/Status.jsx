import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { Link } from 'preact-router/match';
import { api, errorMessage } from '../api.mjs';
import Table from '../components/Table.jsx';
import { useResource } from '../useResource.mjs';

function Rate({ value }) {
  if (value === null) return 'Collecting...';
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
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

export default function Status({ user }) {
  const { data: status, error: refreshError, loading, refresh } = useResource('/status.json');
  const [expandedIp, setExpandedIp] = useState(new URLSearchParams(location.search).get('client'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function block(ip) {
    setBusy(true);
    setError('');
    try {
      await api.post('/blocklist/block', { ip });
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <h1>Gateway status</h1>
    <p class="text-body-secondary">Live connection counters - refreshes every 5 seconds</p>
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
      <h2 class="h4">Proxy throughput</h2>
      <p class="text-body-secondary">Average over the latest five-second sample, measured at the gateway socket.</p>
      <section class="row g-3 mb-4" aria-label="Proxy throughput">
        {[['Upload (client to proxy)', status.traffic.uploadBytesPerSecond], ['Download (proxy to client)', status.traffic.downloadBytesPerSecond]].map(([label, value]) =>
          <div class="col-12 col-sm-6" key={label}><div class="card"><div class="card-body">
            <p>{label}</p><strong class="fs-2"><Rate value={value} /></strong>
          </div></div></div>)}
      </section>
      <Counters rows={status.connections} />
      <h2 class="h4 mt-4" id="active-clients">Active clients by IP</h2>
      {status.clientDetails.omitted > 0 && <div class="alert alert-warning" role="status">
        Showing details for {status.clientDetails.shown} of {status.totals.active} open sockets (limit {status.clientDetails.limit}).
        {' '}{status.clientDetails.omitted} sockets are omitted from IP groups; protocol and country totals still include every socket.
      </div>}
      <p class="text-body-secondary">One group per IP, not per person or device. Expand to see sockets. User-Agent may be missing or spoofed and does not reliably identify a device model.</p>
      <Table headings={['IP address', 'Country', 'Protocols', status.clientDetails.omitted ? 'Displayed sockets' : 'Open client sockets', 'Details', ...(user.admin && status.blocklistAvailable ? ['Actions'] : [])]}>
        {status.clientGroups.map(group => <Fragment key={group.ip}>
          <tr>
            <th scope="row">{group.ip}</th><td>{group.countries.map(country => `${country.name} (${country.code})`).join(', ')}</td>
            <td>{group.protocols.join(', ')}</td><td>{group.active}</td>
            <td><button class="btn btn-sm btn-outline-secondary" aria-expanded={expandedIp === group.ip} onClick={() => {
              const ip = expandedIp === group.ip ? null : group.ip;
              setExpandedIp(ip);
              history.replaceState(null, '', `${location.pathname}${ip ? `?client=${encodeURIComponent(ip)}` : ''}#active-clients`);
            }}>{expandedIp === group.ip ? 'Hide connections' : 'View connections'}</button></td>
            {user.admin && status.blocklistAvailable && <td><button class="btn btn-sm btn-outline-danger" disabled={busy}
              onClick={() => block(group.ip)}>Block IP</button></td>}
          </tr>
          {expandedIp === group.ip && <tr><td colSpan={user.admin && status.blocklistAvailable ? 6 : 5}>
            <Table headings={['Connection ID', 'Protocol', 'Country', 'Reported client (User-Agent)', 'Connected since (UTC)', 'Open for (seconds)']}>
              {status.clients.filter(client => client.ip === group.ip).map(client => <tr key={client.connectionId}>
                <th scope="row" class="text-break">{client.connectionId}</th><td>{client.protocol}</td>
                <td>{client.countryName} ({client.countryCode})</td><td class="text-break">{client.userAgent}</td>
                <td>{client.connectedAt}</td><td>{client.elapsedSeconds}</td>
              </tr>)}
            </Table>
          </td></tr>}
        </Fragment>)}
        {!status.clientGroups.length && <tr><td colSpan={user.admin && status.blocklistAvailable ? 6 : 5}>No active client connections.</td></tr>}
      </Table>
      {status.blocklistAvailable && <p><Link href="/blocked-ips">View blocked IPs</Link></p>}
      <h2 class="h4 mt-4">Connections by country</h2>
      <p class="text-body-secondary">Based on trusted Cloudflare metadata; unavailable values appear as Unknown.</p>
      <Counters rows={status.countries} countries />
      <footer class="mt-4 small text-body-secondary">
        <p>Started {status.startedAt} - Uptime {status.uptimeSeconds}s - <a href="/status.json" data-native>JSON snapshot</a></p>
        <p>Counts reset on restart. Healthy listeners do not prove authenticated browsing works.</p>
      </footer>
    </>}
  </>;
}
