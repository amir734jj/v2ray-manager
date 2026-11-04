import { useState } from 'preact/hooks';
import { api, errorMessage } from '../api.js';
import Table from '../components/Table.jsx';
import { useResource } from '../useResource.js';

export default function BlockedIps({ user }) {
  const { data: status, error: refreshError, loading, refresh } = useResource('/api/status.json');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function change(path, ip) {
    setBusy(true);
    setError('');
    try {
      await api.post(path, { ip });
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <h1>Blocked IPs</h1>
    <p class="text-body-secondary">Blocks persist and immediately disconnect proxy sockets, not management sessions. An IP may be shared.
      Behind Cloudflare, enable trusted client headers or you may block the proxy IP.</p>
    {error && <div class="alert alert-danger" role="alert">{error}</div>}
    {refreshError && <div class="alert alert-danger" role="alert">{refreshError}</div>}
    {loading && <p role="status">Loading blocked IPs...</p>}
    {status && !status.blocklistAvailable && <p role="status">Blocklist controls are unavailable.</p>}
    {status?.blocklistAvailable && <>
      {user.admin && <form class="row g-2 mb-3" onSubmit={event => {
        event.preventDefault();
        change('/api/blocklist/block', new FormData(event.currentTarget).get('ip'));
      }}>
        <div class="col-auto"><label class="visually-hidden" for="block-ip">IP address</label>
          <input class="form-control" id="block-ip" name="ip" placeholder="IPv4 or IPv6 address" required maxLength={45} /></div>
        <div class="col-auto"><button class="btn btn-danger" disabled={busy}>Block IP</button></div>
      </form>}
      <Table headings={['IP address', ...(user.admin ? ['Action'] : [])]}>
        {status.blockedIPs.map(ip => <tr key={ip}><th scope="row">{ip}</th>
          {user.admin && <td><button class="btn btn-sm btn-outline-success" disabled={busy}
            onClick={() => change('/api/blocklist/unblock', ip)}>Unblock IP</button></td>}
        </tr>)}
        {!status.blockedIPs.length && <tr><td colSpan={user.admin ? 2 : 1}>No blocked IPs.</td></tr>}
      </Table>
    </>}
  </>;
}
