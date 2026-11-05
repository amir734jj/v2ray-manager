import { useState } from 'preact/hooks';
import prettyBytes from 'pretty-bytes';
import { api, errorMessage } from '../api.js';
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
    <details class="text-body-secondary mb-3">
      <summary>About gateway traffic and core totals</summary>
    <p class="mt-2">
      Gateway counts are open sockets, not devices or proof of successful protocol authentication.
      Speeds and last observed socket traffic are sampled every five seconds and include WebSocket overhead.
      Connected since is the oldest currently open tunnel.
    </p>
    <p>
      Core totals measure traffic attributed to authenticated V2Ray credentials across all three protocols,
      not lifetime usage. They reset when V2Ray restarts; socket activity and core accounting are separate measurements.
    </p>
    </details>
    {data?.coreStats?.sampledAt && <p class="text-body-secondary">
      Core snapshot: <Timestamp value={data.coreStats.sampledAt} />.
      {' '}Core uptime at snapshot: {data.coreStats.uptimeSeconds} seconds.
      {data.coreStats.status === 'error' && ' Displayed core totals are stale.'}
    </p>}
    {data && <div class="d-grid gap-3">
      {data.users.map(account => <article class="card" key={account.id} aria-labelledby={`user-${account.id}`}>
        <div class="card-body">
          <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
            <div class="mw-100">
              <h2 class="h5 mb-1 text-break" id={`user-${account.id}`}>{account.username}</h2>
              <div class="small text-body-secondary">{account.admin ? 'Administrator' : 'Viewer'}</div>
              <div class="small text-body-secondary">Registered <Timestamp value={account.createdAt} /></div>
            </div>
            <div class="d-flex flex-wrap gap-2">
              <span class={`badge ${account.active ? 'text-bg-success' : 'text-bg-warning'}`}>
                {account.active ? 'Active' : 'Pending approval'}
              </span>
              {account.connection && <span class="badge text-bg-secondary">
                {account.connection.enabled ? 'Enabled' : 'Paused'} / {account.connection.syncStatus}
              </span>}
            </div>
          </div>
          {account.connection?.syncError && <div class="alert alert-danger text-break" role="alert">{account.connection.syncError}</div>}
          {account.connection ? <>
            <div class="mb-3">
              <div class="form-label fw-semibold">Private subscription URL</div>
              {account.connection.subscriptionUrl ? <div class="d-flex flex-column flex-sm-row gap-2">
                <input id={`subscription-${account.id}`} class="form-control flex-grow-1" style={{ minWidth: 0 }}
                  aria-label={`Private subscription URL for ${account.username}`}
                  value={account.connection.subscriptionUrl} readOnly onFocus={event => event.currentTarget.select()} />
                <button class="btn btn-outline-primary flex-shrink-0" onClick={() => copySubscription(account.connection.subscriptionUrl)}>
                  {copied === account.connection.subscriptionUrl ? 'Copied' : 'Copy URL'}
                </button>
              </div> : <p class="small text-body-secondary mb-0">
                This older URL cannot be recovered. Replace it once to display a new URL here; the old URL will stop working.
              </p>}
            </div>
            <dl class="row row-cols-1 row-cols-sm-2 row-cols-lg-4 g-3 mb-0">
              <div class="col"><dt class="small text-body-secondary">Open tunnels</dt><dd class="mb-0">{account.connection.gateway.openTunnels}</dd></div>
              <div class="col"><dt class="small text-body-secondary">Gateway upload</dt><dd class="mb-0"><TrafficRate value={account.connection.gateway.traffic.uploadBytesPerSecond} /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Gateway download</dt><dd class="mb-0"><TrafficRate value={account.connection.gateway.traffic.downloadBytesPerSecond} /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Last observed traffic</dt><dd class="mb-0"><Timestamp value={account.connection.gateway.lastTrafficAt} empty="Not observed" /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Connected since</dt><dd class="mb-0"><Timestamp value={account.connection.gateway.connectedSince} empty="No open tunnels" /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Core upload total</dt><dd class="mb-0"><CoreBytes value={account.connection.coreTraffic?.uploadBytes ?? null} status={data.coreStats?.status} /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Core download total</dt><dd class="mb-0"><CoreBytes value={account.connection.coreTraffic?.downloadBytes ?? null} status={data.coreStats?.status} /></dd></div>
            </dl>
          </> : <p class="text-body-secondary mb-0">Connection not created.</p>}
        </div>
        <div class="card-footer d-flex flex-wrap gap-2">
          {!account.active && <button class="btn btn-sm btn-success" disabled={busy}
            onClick={() => perform(`/api/users/${account.id}/activate`)}>Activate</button>}
          {account.active && !account.connection && <button class="btn btn-sm btn-primary" disabled={busy}
            onClick={() => perform(`/api/users/${account.id}/connection`)}>Create connection</button>}
          {account.connection && <>
            <button class="btn btn-sm btn-warning" disabled={busy}
              onClick={() => change(account, account.connection.enabled ? 'pause' : 'resume')}>
              {account.connection.enabled ? 'Pause' : 'Resume'}
            </button>
            <button class="btn btn-sm btn-outline-danger" disabled={busy}
              onClick={() => change(account, 'reset')}>Reset credentials</button>
            <button class="btn btn-sm btn-outline-primary" disabled={busy}
              onClick={() => change(account, 'subscription')}>Replace subscription URL</button>
          </>}
        </div>
      </article>)}
    </div>}
  </>;
}

export default function Users({ user }) {
  return <section aria-label="User management">
    <h1>Users</h1>
    {user.admin ? <UserList /> : <div class="alert alert-danger" role="alert">Administrator access is required.</div>}
  </section>;
}
