import { useEffect, useState } from 'preact/hooks';
import { api, errorMessage } from '../api.js';
import Table from '../components/Table.jsx';

function RetentionForm({ hours, onSave }) {
  const [draft, setDraft] = useState(String(hours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(String(hours)), [hours]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api.post('/api/destinations/retention', { hours: Number(draft) });
      setSaved(true);
      onSave();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <div class="mb-4">
    <form class="d-flex flex-column flex-sm-row align-items-sm-end gap-2" onSubmit={save}>
      <div>
        <label class="form-label" for="destination-retention">Domain retention (hours)</label>
        <input id="destination-retention" class="form-control" type="number" min="1" step="1"
          required value={draft} disabled={busy} aria-describedby="destination-retention-help"
          onInput={event => {
            setDraft(event.currentTarget.value);
            setSaved(false);
          }} />
      </div>
      <button class="btn btn-outline-primary" type="submit" disabled={busy || Number(draft) === hours}>
        {busy ? 'Saving...' : 'Save retention'}
      </button>
    </form>
    <p id="destination-retention-help" class="small text-body-secondary mt-2">
      Applies to all subscriptions. Older domains expire after this many hours without another observation.
      Shortening retention removes older history; increasing it cannot restore deleted history.
    </p>
    {error && <div class="alert alert-danger" role="alert">{error}</div>}
    {saved && <p class="text-success" role="status">Domain retention saved.</p>}
  </div>;
}

function DestinationList() {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState({ query: '', cursors: [null] });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retentionHours, setRetentionHours] = useState(null);

  function navigate(next) {
    setData(null);
    setLoading(true);
    setSearch(next);
  }

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setData(null);
    setError('');
    setLoading(true);
    api.get('/api/destinations', {
      params: { q: search.query, cursor: search.cursors.at(-1) ?? undefined },
      signal: controller.signal,
    }).then(response => {
      if (active) {
        setData(response.data);
        setRetentionHours(response.data.destinationRetentionHours);
      }
    }).catch(failure => {
      if (active && !controller.signal.aborted) setError(errorMessage(failure));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [search]);

  return <>
    {retentionHours !== null && <RetentionForm hours={retentionHours}
      onSave={() => navigate({ query: search.query, cursors: [null] })} />}
    <p class="text-body-secondary">
      All saved domains{retentionHours !== null ? ` from the last ${retentionHours} hours` : ''}, including background apps.
      One row per subscription and domain.
    </p>
    <form class="d-flex flex-column flex-sm-row align-items-sm-end gap-2 mb-3" onSubmit={event => {
      event.preventDefault();
      navigate({ query: draft.trim(), cursors: [null] });
    }}>
      <div class="flex-grow-1">
        <label class="form-label" for="destination-search">Domain or subscription name</label>
        <input id="destination-search" class="form-control" type="search" maxLength={253} value={draft}
          onInput={event => setDraft(event.currentTarget.value)} />
      </div>
      <button class="btn btn-primary" type="submit">Search</button>
      <button class="btn btn-outline-secondary" type="button" disabled={loading}
        onClick={() => navigate({ query: search.query, cursors: [null] })}>Refresh</button>
    </form>
    {error && <div class="alert alert-danger" role="alert">{error}</div>}
    {data?.destinationStats?.error && <div class="alert alert-warning" role="alert">{data.destinationStats.error}</div>}
    {data?.destinationStats?.status === 'loading' && <p role="status">Waiting for the V2Ray destination stream...</p>}
    {loading && <p role="status">Loading destinations...</p>}
    {data && <>
      <Table headings={['Domain', 'Subscription', 'Last observed']}>
        {data.destinations.map(destination => <tr key={`${destination.subscriptionId}:${destination.domain}`}>
          <th scope="row"><code class="text-break">{destination.domain}</code></th>
          <td class="text-break">{destination.subscriptionName}</td>
          <td><time dateTime={destination.lastSeen}>{new Date(destination.lastSeen).toLocaleString()}</time></td>
        </tr>)}
        {!data.destinations.length && <tr><td colSpan={3}>
          {search.query ? `No matching destinations in the last ${data.destinationRetentionHours} hours.`
            : `No domains observed in the last ${data.destinationRetentionHours} hours.`}
        </td></tr>}
      </Table>
    </>}
    <nav class="d-flex flex-wrap align-items-center gap-3 mt-3" aria-label="Destination pages">
      <button class="btn btn-outline-primary" type="button" disabled={loading || search.cursors.length === 1}
        onClick={() => navigate({ ...search, cursors: search.cursors.slice(0, -1) })}>Previous</button>
      <span aria-live="polite">Page {search.cursors.length}{data ? ` (${data.destinations.length} rows)` : ''}</span>
      <button class="btn btn-outline-primary" type="button" disabled={loading || !data?.nextCursor}
        onClick={() => navigate({ ...search, cursors: [...search.cursors, data.nextCursor] })}>Next</button>
    </nav>
  </>;
}

export default function Destinations({ user }) {
  return <section aria-label="Destination history">
    <h1>Destinations</h1>
    {user.admin ? <DestinationList /> : <div class="alert alert-danger" role="alert">Administrator access is required.</div>}
  </section>;
}
