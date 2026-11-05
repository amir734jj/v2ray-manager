import { useState } from 'preact/hooks';
import { api, errorMessage } from '../api.js';
import { useResource } from '../useResource.js';

function UserList() {
  const { data, error: refreshError, loading, refresh } = useResource('/api/users');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function activate(id) {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/users/${id}/activate`);
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <p class="text-body-secondary">Dashboard accounts are separate from subscriptions. Activating an account grants dashboard access only.</p>
    {error && <div class="alert alert-danger" role="alert">{error}</div>}
    {refreshError && <div class="alert alert-danger" role="alert">{refreshError}</div>}
    {loading && <p role="status">Loading users...</p>}
    {data && <div class="d-grid gap-3">
      {data.users.map(account => <article class="card" key={account.id} aria-labelledby={`user-${account.id}`}>
        <div class="card-body d-flex flex-wrap justify-content-between align-items-start gap-2">
          <div class="mw-100">
            <h2 class="h5 mb-1 text-break" id={`user-${account.id}`}>{account.username}</h2>
            <div class="small text-body-secondary">{account.admin ? 'Administrator' : 'Viewer'}</div>
            <div class="small text-body-secondary">
              Registered <time dateTime={account.createdAt}>{new Date(account.createdAt).toLocaleString()}</time>
            </div>
          </div>
          <span class={`badge ${account.active ? 'text-bg-success' : 'text-bg-warning'}`}>
            {account.active ? 'Active' : 'Pending approval'}
          </span>
        </div>
        {!account.active && <div class="card-footer">
          <button class="btn btn-sm btn-success" disabled={busy} onClick={() => activate(account.id)}>Activate</button>
        </div>}
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
