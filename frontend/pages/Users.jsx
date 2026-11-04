import { useState } from 'preact/hooks';
import { api, errorMessage } from '../api.mjs';
import Table from '../components/Table.jsx';
import { useResource } from '../useResource.mjs';

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
    {error && <div class="alert alert-danger" role="alert">{error}</div>}
    {refreshError && <div class="alert alert-danger" role="alert">{refreshError}</div>}
    {loading && <p role="status">Loading users...</p>}
    {data && <Table headings={['Username', 'Role', 'Status', 'Registered', 'Action']}>
      {data.users.map(account => <tr key={account.id}>
        <th scope="row">{account.username}</th><td>{account.admin ? 'Administrator' : 'Viewer'}</td>
        <td>{account.active ? 'Active' : 'Pending approval'}</td><td>{account.createdAt}</td>
        <td>{!account.active && <button class="btn btn-sm btn-success" disabled={busy}
          onClick={() => activate(account.id)}>Activate</button>}</td>
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
