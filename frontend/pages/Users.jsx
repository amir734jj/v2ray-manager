import { useState } from 'preact/hooks';
import { api, errorMessage } from '../api.js';
import Table from '../components/Table.jsx';
import { useResource } from '../useResource.js';

function UserList() {
  const { data, error: refreshError, loading, refresh } = useResource('/api/users');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);
  const [copied, setCopied] = useState(false);

  async function perform(path, username) {
    setBusy(true);
    setError('');
    try {
      const { data: result } = await api.post(path);
      if (result.subscriptionUrl) {
        setIssued({ username, url: result.subscriptionUrl });
        setCopied(false);
      }
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
    if (issued?.username === account.username && ['reset', 'subscription'].includes(action)) setIssued(null);
    perform(`/api/connections/${account.connection.id}/${action}`, account.username);
  }

  async function copySubscription() {
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
    } catch {
      setError('Could not copy the subscription URL. Select and copy it from the field below.');
    }
  }

  return <>
    {error && <div class="alert alert-danger" role="alert">{error}</div>}
    {refreshError && <div class="alert alert-danger" role="alert">{refreshError}</div>}
    {loading && <p role="status">Loading users...</p>}
    {data?.tunnelError && <div class="alert alert-danger" role="alert">{data.tunnelError}</div>}
    {issued && <div class="alert alert-info">
      <label class="form-label" for="subscription-url">Private subscription URL for {issued.username}</label>
      <input id="subscription-url" class="form-control mb-2" value={issued.url} readOnly
        onFocus={event => event.currentTarget.select()} />
      <p>Save this URL now. Only its hash is stored; it cannot be displayed again after leaving this page.</p>
      <button class="btn btn-sm btn-primary me-2" onClick={copySubscription}>{copied ? 'Copied' : 'Copy URL'}</button>
      <button class="btn btn-sm btn-secondary" onClick={() => setIssued(null)}>Dismiss</button>
    </div>}
    {data && <Table headings={['Username', 'Role', 'Status', 'Registered', 'Connection', 'Actions']}>
      {data.users.map(account => <tr key={account.id}>
        <th scope="row">{account.username}</th><td>{account.admin ? 'Administrator' : 'Viewer'}</td>
        <td>{account.active ? 'Active' : 'Pending approval'}</td><td>{account.createdAt}</td>
        <td>{account.connection ? <>
          <div>{account.connection.enabled ? 'Enabled' : 'Paused'} / {account.connection.syncStatus}</div>
          {account.connection.syncError && <div class="text-danger" role="alert">{account.connection.syncError}</div>}
        </> : 'Not created'}</td>
        <td>
          {!account.active && <button class="btn btn-sm btn-success" disabled={busy}
            onClick={() => perform(`/api/users/${account.id}/activate`, account.username)}>Activate</button>}
          {account.active && !account.connection && <button class="btn btn-sm btn-primary" disabled={busy}
            onClick={() => perform(`/api/users/${account.id}/connection`, account.username)}>Create connection</button>}
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
