import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import Router, { route } from 'preact-router';
import { Link } from 'preact-router/match';
import { io } from 'socket.io-client';
import 'bootstrap/dist/css/bootstrap.min.css';
import { api, errorMessage } from './api.js';
import Navbar from './components/Navbar.jsx';
import BlockedIps from './pages/BlockedIps.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Status from './pages/Status.jsx';
import Users from './pages/Users.jsx';
import Subscriptions from './pages/Subscriptions.jsx';
import Destinations from './pages/Destinations.jsx';
import { RealtimeContext } from './realtime.js';

function Protected({ user, children }) {
  useEffect(() => {
    if (!user) route('/login', true);
  }, [user]);
  return user ? children : <p role="status">Redirecting to login...</p>;
}

function PublicOnly({ user, children }) {
  useEffect(() => {
    if (user) route('/', true);
  }, [user]);
  return user ? <p role="status">Opening dashboard...</p> : children;
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pathname, setPathname] = useState(location.pathname);
  const [socket, setSocket] = useState(null);
  const currentUser = useRef(null);

  useEffect(() => {
    let active = true;
    const interceptor = api.interceptors.response.use(undefined, failure => {
      if (failure.response?.status === 401 && currentUser.current) {
        currentUser.current = null;
        setUser(null);
        setNotice('');
        setError('Your session expired or your account is no longer active. Please log in.');
        route('/login', true);
      }
      return Promise.reject(failure);
    });
    api.get('/api/auth/me').then(({ data }) => {
      if (active) {
        currentUser.current = data.user;
        setUser(data.user);
      }
    }).catch(failure => {
      if (active && failure.response?.status !== 401) setError(errorMessage(failure));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      api.interceptors.response.eject(interceptor);
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setSocket(null);
      return;
    }
    const connection = io({ transports: ['websocket'], autoConnect: false });
    let retry;
    function expire() {
      if (!currentUser.current) return;
      currentUser.current = null;
      setUser(null);
      setNotice('');
      setError('Your session expired or your account is no longer active. Please log in.');
      route('/login', true);
    }
    function connectionError(failure) {
      if (failure.data?.code === 'UNAUTHORIZED') expire();
      else if (failure.data?.code === 'UNAVAILABLE') {
        clearTimeout(retry);
        retry = setTimeout(() => connection.connect(), 5000);
      }
    }
    function connected() { clearTimeout(retry); }
    connection.on('session-expired', expire);
    connection.on('connect_error', connectionError);
    connection.on('connect', connected);
    setSocket(connection);
    connection.connect();
    return () => {
      connection.off('session-expired', expire);
      connection.off('connect_error', connectionError);
      connection.off('connect', connected);
      clearTimeout(retry);
      connection.disconnect();
    };
  }, [user?.id]);

  function login(account) {
    currentUser.current = account;
    setUser(account);
    setError('');
    setNotice('');
    route('/', true);
  }

  function registered(account) {
    setNotice(account.active
      ? 'Administrator account created. You can now log in.'
      : 'Account created. An administrator must activate it before you can log in.');
    setError('');
    route('/login', true);
  }

  async function logout() {
    try {
      await api.post('/api/auth/logout');
      currentUser.current = null;
      setUser(null);
      setError('');
      setNotice('');
      route('/login', true);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  if (loading) return <main class="container py-5"><p role="status">Loading...</p></main>;
  return <>
    <Navbar user={user} pathname={pathname} onLogout={logout} />
    <main class="container pb-5">
      {error && <div class="alert alert-danger" role="alert">{error}</div>}
      <RealtimeContext.Provider value={socket}>
        <Router onChange={({ url }) => setPathname(url.split('?')[0])}>
          <Protected path="/" user={user}><Status user={user} /></Protected>
          <Protected path="/status" user={user}><Status user={user} /></Protected>
          <Protected path="/blocked-ips" user={user}><BlockedIps user={user} /></Protected>
          <Protected path="/users" user={user}><Users user={user} /></Protected>
          <Protected path="/subscriptions" user={user}><Subscriptions user={user} /></Protected>
          <Protected path="/destinations" user={user}><Destinations user={user} /></Protected>
          <PublicOnly path="/login" user={user}><Login onLogin={login} notice={notice} /></PublicOnly>
          <PublicOnly path="/register" user={user}><Register onRegistered={registered} /></PublicOnly>
          <section default><h1>Page not found</h1><Link href="/">Go to status</Link></section>
        </Router>
      </RealtimeContext.Provider>
    </main>
  </>;
}

render(<App />, document.getElementById('app'));
