import { useState } from 'preact/hooks';
import { Link } from 'preact-router/match';
import { api, errorMessage } from '../api.js';

export default function AccountForm({ registering, onSuccess, notice }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(registering ? '/api/auth/register' : '/api/auth/login', body);
      onSuccess(data.user);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <section class="col-md-6 col-lg-5 mx-auto">
    <h1>{registering ? 'Register' : 'Log in'}</h1>
    <p class="text-body-secondary">The first account is an active administrator. Later accounts need administrator approval.</p>
    {notice && <div class="alert alert-success" role="status">{notice}</div>}
    {error && <div class="alert alert-danger" role="alert">{error}</div>}
    <form onSubmit={submit}>
      <label class="form-label" for="username">Username</label>
      <input class="form-control mb-3" id="username" name="username" required minLength={3} maxLength={64}
        pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,63}" autoComplete="username" />
      <label class="form-label" for="password">Password (10-128 characters)</label>
      <input class="form-control mb-3" id="password" name="password" type="password" required minLength={10}
        maxLength={128} autoComplete={registering ? 'new-password' : 'current-password'} />
      <button class="btn btn-primary" disabled={busy}>{busy ? 'Please wait...' : registering ? 'Register' : 'Log in'}</button>
      <Link class="btn btn-link" href={registering ? '/login' : '/register'} aria-disabled={busy}
        onClick={event => {
          if (busy) { event.preventDefault(); event.stopPropagation(); }
        }}>
        {registering ? 'Already registered? Log in' : 'Create an account'}
      </Link>
    </form>
  </section>;
}
