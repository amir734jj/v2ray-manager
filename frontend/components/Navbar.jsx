import { Link } from 'preact-router/match';

export default function Navbar({ user, pathname, onLogout }) {
  const links = user
    ? [
      { href: '/', label: 'Status', active: pathname === '/' || pathname === '/status' },
      { href: '/blocked-ips', label: 'Blocked IPs', active: pathname === '/blocked-ips' },
      ...(user.admin ? [
        { href: '/subscriptions', label: 'Subscriptions', active: pathname === '/subscriptions' },
        { href: '/users', label: 'Users', active: pathname === '/users' },
      ] : []),
    ]
    : [
      { href: '/login', label: 'Log in', active: pathname === '/login' },
      { href: '/register', label: 'Register', active: pathname === '/register' },
    ];

  return <nav class="navbar bg-body-tertiary mb-4" aria-label="Main navigation">
    <div class="container d-flex flex-wrap gap-3">
      <Link class="navbar-brand" href={user ? '/' : '/login'}>Gateway manager</Link>
      <div class="d-flex flex-wrap align-items-center gap-3">
        {links.map(link => <Link key={link.href} href={link.href}
          class={`nav-link${link.active ? ' active fw-bold' : ''}`}
          aria-current={link.active ? 'page' : undefined}>{link.label}</Link>)}
      </div>
      {user && <div class="d-flex flex-wrap align-items-center gap-3">
        <span>{user.username} ({user.admin ? 'Administrator' : 'Viewer'})</span>
        <button class="btn btn-outline-secondary" type="button" onClick={onLogout}>Log out</button>
      </div>}
    </div>
  </nav>;
}
