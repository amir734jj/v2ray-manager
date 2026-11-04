# V2Ray Manager

VLESS, VMess, Trojan, and Shadowsocks over WebSocket, behind Cloudflare and Coolify.

```text
Client :443 -> Cloudflare -> Coolify -> gateway :53217 -> V2Ray
```

| Protocol | WebSocket path | Internal V2Ray port |
|----------|----------------|---------------------|
| VLESS | `/vless` | 53217 |
| VMess | `/vmess` | 53218 |
| Trojan | `/trojan` | 53219 |
| Shadowsocks | `/shadowsocks` | 53220 |

## Deploy

1. Deploy [docker-compose.yaml](./docker-compose.yaml) in Coolify with:

   ```text
   V2RAY_UUID=<shared credential>
   V2RAY_HOST=ws.hesamian.com
   DATABASE_URL=<PostgreSQL connection URL from Coolify>
   ```

2. Attach `https://ws.hesamian.com` to **gateway port 53217**, using HTTP
   upstream with WebSocket upgrades. Do not attach domains to `init` or `v2ray`.
3. Optionally attach `https://v2ray.hesamian.com` to the same port for status.
4. Point Cloudflare DNS at the server, enable proxying and WebSockets, and use
   **Full (strict)** TLS with a valid origin certificate. Exclude tunnel paths
   from caching and interactive challenges.
5. Deploy and import the generated profiles. Clients use **port 443**.
6. Restrict access to the management hostname during setup, then visit
   `/register` over HTTPS and create the administrator account. The first
   registered user becomes the active administrator, so anyone who reaches an
   uninitialized deployment can claim this role.

## Management accounts

The management dashboard uses Preact, Preact Router, Axios and Vite. Passport.js authenticates local
username/password credentials and restores database-backed sessions. Pug is no
longer used.

- Usernames are case-insensitive, 3-64 characters, using letters, numbers,
  dots, underscores or hyphens. Passwords must be 10-128 characters.
- The first registration is the active administrator; later accounts require
  approval. The administrator activates them on the **Users** page.
  Active non-administrators can view status and blocked IPs, but cannot change
  the blocklist, list accounts or activate users. Concurrent registrations use
  serializable database transactions; if repeated conflicts occur, retry the
  registration.
- Only the initial account is an administrator. There is currently no interface
  for changing roles, deactivating users or resetting passwords.
- Passwords are salted and hashed with Argon2id using the `argon2` library.
  Existing scrypt password hashes are upgraded on the user's next successful
  login. Passwords are hashed, not reversibly encrypted. Only hashes of random
  session tokens are stored. Sessions expire after seven days; logout revokes the
  current session. Cookies are HttpOnly, SameSite=Strict and Secure by default.
- Use HTTPS in production, including behind Coolify. For local HTTP development
  only, set `GATEWAY_SECURE_COOKIES=false`; this disables Secure cookies and
  uses a separate cookie name.
- Login and registration share a limit of 20 attempts per 15 minutes per socket
  peer IP. Authentication rate limiting does not trust forwarded IP headers, so
  clients behind a reverse proxy may share the same limit. The limit is in-memory
  and resets on restart. State-changing requests require a matching Origin
  header, including login, registration, logout, approval and IP changes.

Sequelize initializes `gateway_users` and `gateway_sessions` in the same
PostgreSQL database as the blocklist. The database role needs table and index
creation and read/write permissions. Preserve these tables across redeploys;
deleting all accounts allows the next registrant to become administrator.
There are no default credentials or local-file fallback.

Management accounts protect the dashboard only. V2Ray tunnel paths, shared UUID
authentication and `/healthz` are unchanged. Registering or activating an
account does not issue or revoke tunnel credentials.

The navigation bar links to **Status**, **Blocked IPs**, and, for administrators,
**Users**. Login and registration have their own pages. Active viewers can open
the status and blocklist pages, but management actions remain administrator-only.

The gateway Docker build installs dependencies and builds the browser assets.
For a non-Docker setup:

```bash
npm ci
npm run build
# Set DATABASE_URL (and GATEWAY_SECURE_COOKIES=false only for local HTTP):
node gateway/server.mjs
```

Rebuild after frontend changes. Source is in [frontend](./frontend); generated
`gateway/public` assets are not committed.

For frontend development, start the gateway with `DATABASE_URL` and
`GATEWAY_SECURE_COOKIES=false`, then run `npm run dev` in another terminal.
Open the Vite URL it prints (normally `http://127.0.0.1:5173`). Vite proxies
management API requests to the local gateway on port 53217, preserving the
browser's host for same-origin checks. If the gateway port changes, update the
proxy target in [frontend/vite.config.mjs](./frontend/vite.config.mjs). Both
servers must be running; the gateway still requires PostgreSQL. Do not expose
the HTTP development server or disable secure cookies in production.

## Profiles

Set `FTP_HOST`, `FTP_USER`, `FTP_PASS`, and optionally `FTP_PATH` to upload
these files for each protocol:

- `client.json` - client profile
- `connection.txt` - share link
- `qr.png` - share-link QR code

Shadowsocks links require a client supporting `v2ray-plugin`; Shadowsocks is
TCP-only. Generated SOCKS listeners use local port **10808**.

Old files, profiles, and Coolify routes must be removed manually. There is no
automatic legacy cleanup or migration; regenerate and re-import old profiles.

## Rotate credentials

```bash
npm ci
npm run rotate -- ws.hesamian.com

# Or choose the UUID:
npm run rotate -- ws.hesamian.com --uuid <uuid>
```

This writes local server/client configs and protocol exports. Existing configs
must already use WebSocket; remove older configs to regenerate from templates.

Set the new `V2RAY_UUID` in Coolify and **redeploy**. Restarting alone does not
apply locally generated files.

## Status and logs

- **Status:** `https://v2ray.hesamian.com` (or `/status` on the gateway).
  Refreshes every **5 seconds**, with active tunnels, attempts, and errors by
  protocol and country, plus aggregate proxy upload and download throughput.
  Rates are averages over the most recent five-second sampling interval and
  initially show "Collecting..." until the first sample. Upload means client to
  gateway; download means gateway to client. They measure routed gateway socket
  bytes, including WebSocket framing and handshake response overhead, not
  application payload or external TLS overhead. `/status.json` also exposes
  cumulative `uploadBytes` and `downloadBytes`, rates in bytes per second, and
  the actual `intervalSeconds` (rates and interval are null before the first
  sample). Closed sockets contribute to the sample; all values reset on restart.
  Clients are grouped by IP; expand a group to see
  connection IDs, countries, reported User-Agents, start times, and elapsed seconds.
  The selected group stays expanded across refreshes. `/status.json` provides
  both grouped summaries and individual connections. At most **1,000 active
  connection details** are retained, with User-Agent text limited to 256 characters.
  Closed connections are removed immediately; no connection history, request
  headers, or payloads are stored in status memory. When details are omitted,
  the page warns that IP groups cover only displayed sockets; protocol/country
  totals still count all connections.
- **Health:** `https://ws.hesamian.com/healthz` returns `ok`.
- **Logs:** expanded request, connection, and error logs appear in Coolify stdout,
  Each WebSocket attempt has an ID shared with the status page, with its IP,
  country, protocol, reported client, and headers in one record. Close logs
  include the same ID and socket lifetime; proxy failures also carry the ID.
  HTTP request headers and error stacks are included. Common credential
  headers (Authorization, cookies, X-Api-Key, and Cloudflare access tokens) are
  redacted; query strings and bodies are not logged. Other headers may contain sensitive data,
  so restrict log access and retention.
  Gateway Docker logs rotate at **10 MB per file**, with **three files** retained.

### IP blocklist

Use **Block IP** next to an active IP group, or enter an address in **Blocked IPs**.
Blocking immediately disconnects every matching proxy socket and rejects new
WebSocket connections with HTTP 403. **Unblock IP** allows future connections.
The status page remains reachable from blocked IPs.

**Only active administrators can block or unblock IPs.** Active viewers have
read-only access. Session authentication, administrator checks and same-origin
POST checks are enforced server-side.
IP blocking is not device identification: people may share an IP or change IPs,
and everyone using the shared UUID remains indistinguishable by credentials.

The list is limited to **1,000 IPs**, with no automatic eviction. Sequelize
uses PostgreSQL to store it in `gateway_ip_blocklist` via `DATABASE_URL`; the database role
needs permission to create, alter, and update that table. There is no local-file fallback.
Database initialization and blocklist persistence are in [gateway/database.mjs](./gateway/database.mjs).
The table and constraint are initialized at startup; there are no versioned migrations.
The gateway loads a bounded cache at startup and updates it after committed
changes through this page. Use a single gateway instance; direct SQL changes
require restarting it to reload the cache. Conflicting concurrent updates are
rejected and can be retried. Database initialization failures
stop startup; failed updates report an error and do not disconnect clients.
Live connections/counters stay in memory only; no connection history, headers,
or payloads are written to PostgreSQL.
Behind Cloudflare, enable trusted client headers as described below, or the
blocked address may be your reverse proxy rather than an individual client.

Counters reset on restart. Open tunnels and healthy listeners do not prove
authenticated browsing works. An IP may represent multiple users or devices;
each connection ID identifies a socket and changes on reconnect. User-Agent
may hint at an app or device but can be missing or spoofed.
Device models cannot be reliably detected. Rows disappear when sockets close.
The page and JSON expose full client IPs and User-Agents to active management
accounts. Limit account approvals and restrict management routes separately
from tunnel paths when appropriate. Credentials are not shown.

For country counters and real client IP logs, enable Cloudflare IP Geolocation,
preserve `CF-Connecting-IP` / `CF-IPCountry`, and set
`GATEWAY_TRUST_CLOUDFLARE_HEADERS=true`. Only enable this when origin access is
restricted to Cloudflare and trusted proxies; otherwise headers can be forged.
By default, country is Unknown and logs use the socket peer IP. Restrict access
to IP logs and configure retention.

If v2rayNG connects but browsing fails, ensure its local SOCKS port matches
**10808**, re-import the updated profile, and restart the VPN.
