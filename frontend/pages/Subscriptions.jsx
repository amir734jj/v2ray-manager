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

function SubscriptionList() {
  const { data, error: refreshError, loading, refresh } = useResource('/api/connections');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);
  const [name, setName] = useState('');

  async function perform(path, body) {
    setBusy(true);
    setError('');
    try {
      await api.post(path, body);
      if (path === '/api/connections') setName('');
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function change(connection, action) {
    if (action === 'reset' && !window.confirm(`Reset credentials for ${connection.name}? Existing profiles and the subscription URL will stop working.`)) return;
    if (action === 'subscription' && !window.confirm(`Replace the subscription URL for ${connection.name}? The old URL will stop updating, but existing tunnel profiles will continue working.`)) return;
    perform(`/api/connections/${connection.id}/${action}`);
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
    <p class="text-body-secondary">Create as many independent subscriptions as you need. No dashboard user account is required.</p>
    <form class="d-flex flex-column flex-sm-row align-items-sm-end gap-2 mb-4" onSubmit={event => {
      event.preventDefault();
      perform('/api/connections', { name });
    }}>
      <div class="flex-grow-1">
        <label class="form-label" for="subscription-name">Subscription name</label>
        <input id="subscription-name" class="form-control" value={name} required maxLength={128}
          disabled={busy} onInput={event => setName(event.currentTarget.value)} />
      </div>
      <button class="btn btn-primary flex-shrink-0" type="submit" disabled={busy || !name.trim()}>
        Create subscription
      </button>
    </form>
    {loading && <p role="status">Loading subscriptions...</p>}
    {data?.tunnelError && <div class="alert alert-danger" role="alert">{data.tunnelError}</div>}
    {data?.coreStats?.error && <div class="alert alert-warning" role="alert">{data.coreStats.error}</div>}
    <p class="text-body-secondary">Subscription URLs contain private credentials. Share them only with their intended recipients.</p>
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
    {data?.connections.length === 0 && <p>No subscriptions yet. Create your first subscription above.</p>}
    {data && <div class="d-grid gap-3">
      {data.connections.map(connection => <article class="card" key={connection.id} aria-labelledby={`connection-${connection.id}`}>
        <div class="card-body">
          <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
            <div class="mw-100">
              <h2 class="h5 mb-1 text-break" id={`connection-${connection.id}`}>{connection.name}</h2>
              <div class="small text-body-secondary">Created <Timestamp value={connection.createdAt} /></div>
            </div>
            <div class="d-flex flex-wrap gap-2">
              <span class="badge text-bg-secondary">
                {connection.enabled ? 'Enabled' : 'Paused'} / {connection.syncStatus}
              </span>
            </div>
          </div>
          {connection.syncError && <div class="alert alert-danger text-break" role="alert">{connection.syncError}</div>}
            <div class="mb-3">
              <div class="form-label fw-semibold">Private subscription URL</div>
              {connection.subscriptionUrl ? <div class="d-flex flex-column flex-sm-row gap-2">
                <input id={`subscription-${connection.id}`} class="form-control flex-grow-1" style={{ minWidth: 0 }}
                  aria-label={`Private subscription URL for ${connection.name}`}
                  value={connection.subscriptionUrl} readOnly onFocus={event => event.currentTarget.select()} />
                <button class="btn btn-outline-primary flex-shrink-0" onClick={() => copySubscription(connection.subscriptionUrl)}>
                  {copied === connection.subscriptionUrl ? 'Copied' : 'Copy URL'}
                </button>
              </div> : <p class="small text-body-secondary mb-0">
                This older URL cannot be recovered. Replace it once to display a new URL here; the old URL will stop working.
              </p>}
            </div>
            <dl class="row row-cols-1 row-cols-sm-2 row-cols-lg-4 g-3 mb-0">
              <div class="col"><dt class="small text-body-secondary">Open tunnels</dt><dd class="mb-0">{connection.gateway.openTunnels}</dd></div>
              <div class="col"><dt class="small text-body-secondary">Gateway upload</dt><dd class="mb-0"><TrafficRate value={connection.gateway.traffic.uploadBytesPerSecond} /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Gateway download</dt><dd class="mb-0"><TrafficRate value={connection.gateway.traffic.downloadBytesPerSecond} /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Last observed traffic</dt><dd class="mb-0"><Timestamp value={connection.gateway.lastTrafficAt} empty="Not observed" /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Connected since</dt><dd class="mb-0"><Timestamp value={connection.gateway.connectedSince} empty="No open tunnels" /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Core upload total</dt><dd class="mb-0"><CoreBytes value={connection.coreTraffic?.uploadBytes ?? null} status={data.coreStats?.status} /></dd></div>
              <div class="col"><dt class="small text-body-secondary">Core download total</dt><dd class="mb-0"><CoreBytes value={connection.coreTraffic?.downloadBytes ?? null} status={data.coreStats?.status} /></dd></div>
            </dl>
        </div>
        <div class="card-footer d-flex flex-wrap gap-2">
            <button class="btn btn-sm btn-warning" disabled={busy}
              onClick={() => change(connection, connection.enabled ? 'pause' : 'resume')}>
              {connection.enabled ? 'Pause' : 'Resume'}
            </button>
            <button class="btn btn-sm btn-outline-danger" disabled={busy}
              onClick={() => change(connection, 'reset')}>Reset credentials</button>
            <button class="btn btn-sm btn-outline-primary" disabled={busy}
              onClick={() => change(connection, 'subscription')}>Replace subscription URL</button>
        </div>
      </article>)}
    </div>}
  </>;
}

export default function Subscriptions({ user }) {
  return <section aria-label="Subscription management">
    <h1>Subscriptions</h1>
    {user.admin ? <SubscriptionList /> : <div class="alert alert-danger" role="alert">Administrator access is required.</div>}
  </section>;
}
