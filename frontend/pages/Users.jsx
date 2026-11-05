import { useState } from 'preact/hooks';
import prettyBytes from 'pretty-bytes';
import { api, errorMessage } from '../api.js';
import Table from '../components/Table.jsx';
import TrafficRate from '../components/TrafficRate.jsx';
import { useResource } from '../useResource.js';

function Timestamp({ value, empty }) {
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : empty;
}

function CoreBytes({ value, status }) {
  if (value === null) return status === 'error' ? 'Unavailable' : 'Collecting...';
  return <span title={`${value} bytes`}>{prettyBytes(Number(value), { binary: true })}</span>;
}

function UserList() {
  const { data, error: refreshError, loading, refresh } = useResource('/api/users');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);

  async function perform(path) {
    setBusy(true);
    setError('');
    try {
      await api.post(path);
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function change(account, action) {
    if (action === 'reset' && !window.confirm(`Reset ${account.username}'s credentials? Existing profiles and the subscription URL will stop working.`)) return;
    if (action === 'subscription' && !window.confirm(`Replace ${account.username}'s subscription URL? Their old URL will stop updating, but existing tunnel profiles will continue working.`)) return;
    perform(`/api/connections/${account.connection.id}/${action}`);
  }

  async function copySubscription(url) {
    setError('');
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      setError('Could not copy the subscription URL. Select and copy it from its field.');
    }
  }

  return <>
    {error && <div class="alert alert-danger" role="alert">{error}</div>}
    {refreshError && <div class="alert alert-danger" role="alert">{refreshError}</div>}
    {loading && <p role="status">Loading users...</p>}
    {data?.tunnelError && <div class="alert alert-danger" role="alert">{data.tunnelError}</div>}
    {data?.coreStats?.error && <div class="alert alert-warning" role="alert">{data.coreStats.error}</div>}
    <p class="text-body-secondary">Subscription URLs contain private credentials. Share them only with their account owners.</p>
    <p class="text-body-secondary">
      Gateway counts are open sockets, not devices or proof of successful protocol authentication.
      Speeds and last observed socket traffic are sampled every five seconds and include WebSocket overhead.
      Connected since is the oldest currently open tunnel.
    </p>
    <p class="text-body-secondary">
      Core totals measure traffic attributed to authenticated V2Ray credentials across all three protocols,
      not lifetime usage. They reset when V2Ray restarts; socket activity and core accounting are separate measurements.
    </p>
    {data?.coreStats?.sampledAt && <p class="text-body-secondary">
      Core snapshot: <Timestamp value={data.coreStats.sampledAt} />.
      {' '}Core uptime at snapshot: {data.coreStats.uptimeSeconds} seconds.
      {data.coreStats.status === 'error' && ' Displayed core totals are stale.'}
    </p>}
    {data && <Table headings={['Username', 'Role', 'Status', 'Registered', 'Connection', 'Subscription URL', 'Open tunnels', 'Connected since', 'Gateway upload', 'Gateway download', 'Last observed traffic', 'Core upload total', 'Core download total', 'Actions']}>
      {data.users.map(account => <tr key={account.id}>
        <th scope="row">{account.username}</th><td>{account.admin ? 'Administrator' : 'Viewer'}</td>
        <td>{account.active ? 'Active' : 'Pending approval'}</td><td>{account.createdAt}</td>
        <td>{account.connection ? <>
          <div>{account.connection.enabled ? 'Enabled' : 'Paused'} / {account.connection.syncStatus}</div>
          {account.connection.syncError && <div class="text-danger" role="alert">{account.connection.syncError}</div>}
        </> : 'Not created'}</td>
        <td>{account.connection ? account.connection.subscriptionUrl ? <>
          <input class="form-control mb-2" aria-label={`Private subscription URL for ${account.username}`}
            value={account.connection.subscriptionUrl} readOnly onFocus={event => event.currentTarget.select()} />
          <button class="btn btn-sm btn-outline-primary" onClick={() => copySubscription(account.connection.subscriptionUrl)}>
            {copied === account.connection.subscriptionUrl ? 'Copied' : 'Copy URL'}
          </button>
        </> : <span>Older URL cannot be recovered. Choose Replace subscription URL once to display a new one here. The old URL will stop working.</span> : '-'}</td>
        <td>{account.connection ? account.connection.gateway.openTunnels : '-'}</td>
        <td>{account.connection ? <Timestamp value={account.connection.gateway.connectedSince} empty="No open tunnels" /> : '-'}</td>
        <td class="text-nowrap">{account.connection ? <TrafficRate value={account.connection.gateway.traffic.uploadBytesPerSecond} /> : '-'}</td>
        <td class="text-nowrap">{account.connection ? <TrafficRate value={account.connection.gateway.traffic.downloadBytesPerSecond} /> : '-'}</td>
        <td>{account.connection ? <Timestamp value={account.connection.gateway.lastTrafficAt} empty="Not observed" /> : '-'}</td>
        <td class="text-nowrap">{account.connection ? <CoreBytes value={account.connection.coreTraffic?.uploadBytes ?? null} status={data.coreStats?.status} /> : '-'}</td>
        <td class="text-nowrap">{account.connection ? <CoreBytes value={account.connection.coreTraffic?.downloadBytes ?? null} status={data.coreStats?.status} /> : '-'}</td>
        <td>
          {!account.active && <button class="btn btn-sm btn-success" disabled={busy}
            onClick={() => perform(`/api/users/${account.id}/activate`)}>Activate</button>}
          {account.active && !account.connection && <button class="btn btn-sm btn-primary" disabled={busy}
            onClick={() => perform(`/api/users/${account.id}/connection`)}>Create connection</button>}
          {account.connection && <div class="d-flex flex-wrap gap-2">
            <button class="btn btn-sm btn-warning" disabled={busy}
              onClick={() => change(account, account.connection.enabled ? 'pause' : 'resume')}>
              {account.connection.enabled ? 'Pause' : 'Resume'}
            </button>
            <button class="btn btn-sm btn-outline-danger" disabled={busy}
              onClick={() => change(account, 'reset')}>Reset credentials</button>
            <button class="btn btn-sm btn-outline-primary" disabled={busy}
              onClick={() => change(account, 'subscription')}>Replace subscription URL</button>
          </div>}
        </td>
      </tr>)}
    </Table>}
  </>;
}

export default function Users({ user }) {
  return <section aria-label="User management">
    <h1>Users</h1>
    {user.admin ? <UserList /> : <div class="alert alert-danger" role="alert">Administrator access is required.</div>}
  </section>;
}
