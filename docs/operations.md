# Operations reference

For the quick start, see the [README](../README.md).

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

These WebSocket paths are public to tunnel clients: they do not require a
management account, session cookie, or browser Origin header. V2Ray still
validates its own configured credentials, and the gateway's IP blocklist still
applies. A plain HTTP request to a tunnel path receives `426 Upgrade Required`.
Keep management routes protected separately from tunnel paths in any external
access policy.

Management HTTP endpoints are under `/api`: authentication uses `/api/auth/*`,
user management uses `/api/users`, IP controls use `/api/blocklist/*`, and the
status snapshot is at `/api/status.json`. The old `/auth/*`, `/blocklist/*`,
and `/status.json` paths are no longer available; update external clients and
access policies when redeploying. Browser page routes, `/healthz`, tunnel
paths, and the `/socket.io/` WebSocket transport are unchanged.

## Deploy

1. Deploy [docker-compose.yaml](../docker-compose.yaml) in Coolify with:

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
   and the management Socket.IO path `/socket.io/` from caching and interactive
   challenges. Allow WebSocket upgrades on both.
5. Deploy and import the generated profiles. Clients use **port 443**.
6. Restrict access to the management hostname during setup, then visit
   `/register` over HTTPS and create the administrator account. The first
   registered user becomes the active administrator, so anyone who reaches an
   uninitialized deployment can claim this role.

## Management accounts

The management dashboard uses Preact, Preact Router, Axios, Socket.IO and Vite.
Passport.js authenticates local username/password credentials and restores
database-backed sessions. Pug is no longer used.

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
- The Socket.IO connection uses WebSocket at `/socket.io/` and requires the same
  active account cookie and a matching Origin. Status and blocklist snapshots
  are available to active accounts; user lists are restricted to administrators.
  Sessions are rechecked before updates, and logout disconnects their sockets.
  Connection errors and stale data are shown in the UI; the client reconnects
  and resubscribes after an interruption.

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

The root npm workspace has separate frontend, gateway, and generator packages
with a shared lockfile. Frontend libraries such as uPlot are frontend
dependencies; Vite is a frontend development dependency. The gateway image
installs only gateway runtime dependencies and copies in the built browser
assets, not the frontend's packages.

The gateway Docker build uses Node LTS/npm (`node:lts-bookworm-slim`) to install dependencies and build the
browser assets, then runs the gateway with `oven/bun:latest` as the non-root
`bun` user. Both stages use Debian for native dependency compatibility. Pull
the base image when rebuilding to pick up newer Bun releases. The generator
still uses Node. The gateway healthcheck also uses Bun.
Bun has no `lts` image tag; `latest` tracks its stable releases.
For a non-Docker setup, install Node/npm for the build and Bun for the gateway:

```bash
npm ci
npm run build
# Set DATABASE_URL (and GATEWAY_SECURE_COOKIES=false only for local HTTP):
bun gateway/server.js
```

Rebuild after frontend changes. Source is in [frontend](../frontend); generated
`gateway/public` assets are not committed.

For frontend development, start the gateway with `DATABASE_URL` and
`GATEWAY_SECURE_COOKIES=false`, then run `npm run dev` in another terminal.
Open the Vite URL it prints (normally `http://127.0.0.1:5173`). Vite proxies
management API and Socket.IO requests to the local gateway on port 53217,
preserving the browser's host for same-origin checks. If the gateway port changes, update the
proxy target in [frontend/vite.config.js](../frontend/vite.config.js). Both
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

### Shadowsocks in v2rayNG

Import the generated `shadowsocks/client.json` as a **custom configuration**,
not the `ss://` link or QR code. v2rayNG's Shadowsocks link importer does not
apply the `v2ray-plugin` WebSocket/TLS options, so importing that link can
silently create a plain-TCP profile. Raw Shadowsocks TCP cannot pass through
this Cloudflare HTTP/WebSocket deployment.

The generated JSON explicitly sets WebSocket transport, TLS, the public hostname
for SNI and Host, and path `/shadowsocks`. Use the generated file, not the
unfilled template, and re-import it after changing credentials or the hostname.
The Shadowsocks-only profile accepts local SOCKS UDP so v2rayNG's VPN bridge
can send DNS queries. Local TCP/UDP port 53 queries are intercepted by a DNS
outbound; DNS requests travel over TCP through the Shadowsocks tunnel.
Only the gateway hostname is bootstrapped using direct encrypted DoH to
`https://1.1.1.1/dns-query`, avoiding a circular dependency on the tunnel.
Other SOCKS UDP traffic is blocked, not sent directly or forwarded through
the TCP-only Shadowsocks server. This does not enable general UDP or QUIC.
Prefer VLESS, VMess, or Trojan when using share links in v2rayNG.

If an older custom profile reports `socks5 client res.rep 7`, regenerate and
re-import it: older Shadowsocks profiles disabled local SOCKS UDP entirely.
Redeploying regenerates FTP exports when configured; `npm run rotate` also
updates local profiles (pass the existing `--uuid` to retain credentials).

Client logs showing `transport/internet/tcp` directly to the public hostname
on port 443 followed by `failed to read IV` / `connection reset by peer`
are consistent with a missing WebSocket/TLS transport; those errors alone
do not establish a Bun regression.

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

- **Gateway CPU and memory:** the status dashboard, authenticated
  `/api/status.json`, and live Socket.IO status snapshots include `resources`.
  `cpuPercent` measures gateway-process user plus system CPU time over the
  actual sampling interval (`intervalSeconds`), sampled every five seconds.
  100% means one fully occupied CPU core; multithreaded usage can exceed 100%.
  CPU and interval are initially `null` ("Collecting..." in the dashboard).
  `resources.memory` reports current `rssBytes`, `heapUsedBytes`,
  `heapTotalBytes`, `externalBytes`, and `arrayBuffersBytes` at each snapshot.
  Array-buffer memory is included in external memory; these values are not
  additive. The dashboard shows RSS and used/allocated JavaScript heap in
  binary units. These metrics cover only the gateway process, not total
  host/container resources, PostgreSQL, or V2Ray.
  Select **Show history graphs** on the status page to plot these four metrics,
  proxy upload/download throughput, open client sockets, connection attempts,
  and proxy failures. Attempts and failures are cumulative counts that reset
  when the gateway restarts. Graphs are hidden by default; hiding
  them stops history requests and reopening them resets the range to one hour.
  The graphs cover
  for the last 5 or 15 minutes, 1 or 6
  hours, or 24 hours using uPlot. Drag a chart to zoom and use **Reset zoom** to
  restore the selected range. Charts refresh every 30 seconds; minima and maxima
  use all five-second samples in the selected range, including when zoomed.
  Graphs show per-bucket minima
  and maxima rather than every point. Each chart uses its own vertical scale,
  and lines connect samples across gaps (including gateway downtime). The authenticated `/api/resource-history`
  endpoint provides the same bounded summaries. Bun can report heap used
  greater than heap allocated, so do not treat these values as a utilization ratio.
  Samples are kept in a disk-backed LevelDB database for 24 hours across gateway
  restarts, then deleted; they are not kept as a full history in application memory.
  LevelDB still uses a small write buffer and cache. The Docker volume
  `gateway-metrics` must be preserved across redeploys and writable by the
  container's `bun` user. It stores gateway CPU, memory, proxy throughput, and
  connection counter samples. Older samples remain available; connection
  counter history starts when this version is deployed.
  For non-Docker use, `GATEWAY_METRICS_PATH` overrides the default
  `./data/resource-history` directory. Only one gateway process may open the
  same LevelDB directory at a time. Database open and write failures are logged;
  the dashboard reports recording errors and failed history requests.
- **Status:** `https://v2ray.hesamian.com` (or `/status` on the gateway).
  Socket.IO pushes connection, blocklist and user changes, along with periodic
  snapshots. Status includes active tunnels, attempts, and errors by protocol
  and country, plus aggregate proxy upload and download throughput.
  Rates are averages over the most recent five-second sampling interval and
  initially show "Collecting..." until the first sample. Upload means client to
  gateway; download means gateway to client. They measure routed gateway socket
  bytes, including WebSocket framing and handshake response overhead, not
  application payload or external TLS overhead. `/api/status.json` also exposes
  cumulative `uploadBytes` and `downloadBytes`, rates in bytes per second, and
  the actual `intervalSeconds` (rates and interval are null before the first
  sample). Closed sockets contribute to the sample; all values reset on restart.
  Clients are grouped by IP; expand a group to see
  connection IDs, countries, reported User-Agents, start times, and elapsed seconds.
  Both IP groups and expanded connections show upload/download speeds, sampled
  on the same five-second interval as aggregate throughput and formatted in
  binary bytes per second. New connections show "Collecting..." until their first
  sample; a group does too only while none of its displayed sockets are sampled.
  New unsampled sockets do not hide rates from already sampled sockets. While
  sampling is incomplete, the socket count shows how many are sampled; the API
  exposes this count as `clientGroups[].traffic.sampledSockets`.
  Group speeds sum only the sampled, displayed, currently open sockets for that IP;
  closed and omitted sockets still contribute to aggregate throughput, so group
  speeds need not add up to the gateway total. `/api/status.json` and Socket.IO
  expose these rates as `traffic.uploadBytesPerSecond` and
  `traffic.downloadBytesPerSecond` on each `clientGroups` and `clients` entry.
  Individual client traffic also includes cumulative `uploadBytes`,
  `downloadBytes` and the sampled `intervalSeconds`. This measures actual
  traffic, not the client's maximum available bandwidth.
  Detailed speed state is allocated only for the existing maximum of 1,000
  displayed connections and updated in place by the shared sampler. There are
  no per-client timers or speed histories; closing a connection releases its
  detail state. Omitted connections and upstream sockets keep only the existing
  aggregate byte-counter baselines.
  The selected group stays expanded across refreshes. `/api/status.json` provides
  both grouped summaries and individual connections. At most **1,000 active
  connection details** are retained, with User-Agent text limited to 256 characters.
  Closed connections are removed immediately; no connection history, request
  headers, or payloads are stored in status memory. When details are omitted,
  the page warns that IP groups cover only displayed sockets; protocol/country
  totals still count all connections.
  IP groups also show approximate city/region/country, ISP and ASN from
  `https://ipwho.is/<IP>`; expand a group for organization, timezone, postal code
  and approximate coordinates. These lookups send public client IPs to ipwho.is
  from the gateway, only when status is viewed. `ipaddr.js` classifies addresses;
  only ordinary unicast addresses are queried, excluding private, loopback,
  link-local, multicast, reserved and special-purpose ranges.
  VPNs/proxies may report their exit location; this does not
  identify a person, device or exact address. Cloudflare-based country counters
  and per-connection metadata are unchanged; known Cloudflare countries remain
  visible while a lookup is pending or unavailable.
  The process-local `lru-cache` holds up to 2,000 IPs for 24 hours, automatically
  expires entries and evicts least-recently-used results, shares in-flight
  requests across HTTP and Socket.IO, and limits concurrent requests
  to four with a five-second timeout. Failed lookups are logged and retried
  after five minutes when status is viewed again. HTTP 429 pauses new lookups
  for the provider's Retry-After (at least five minutes, or 24 hours if absent).
  The UI reports loading/unavailable/rate-limited results without interrupting
  tunnels. Cache entries are not persisted and reset on restart. The free
  service currently allows 1,000 requests/day; cached IPs avoid repeat requests
  but a large number of new IPs can still exhaust that allowance.
- **Health:** `https://ws.hesamian.com/healthz` returns `ok`.
- **Logs:** asynchronous, single-line `pino-pretty` records appear in Coolify
  stdout, for example
  `[20:57:39] INFO: Gateway upstream throughput {"gatewayToV2rayMbps":1.2,"v2rayToGatewayMbps":0.4}`.
  Times are UTC and structured fields are shown inline as JSON.
  Routine proxy connection openings and closings, dashboard requests, assets,
  health checks and other requests are not logged. The status page still shows
  active connection details. Blocked attempts, errors, startup and administrative
  blocklist changes remain logged; proxy errors include the connection ID shown
  in status. Error stacks are escaped inside the error field, not printed on
  separate lines. Restrict log access and retention.
  Every **five seconds**, `Gateway upstream throughput` reports
  `gatewayToV2rayMbps` and `v2rayToGatewayMbps` in decimal megabits per second,
  cumulative `gatewayToV2rayBytes` and `v2rayToGatewayBytes`, and the actual
  `intervalSeconds` rounded to two decimal places for display. Rates use the
  unrounded interval. These use the **upstream socket counters**, not the
  client-facing dashboard meter. They include HTTP upgrade handshakes,
  WebSocket framing and failed upstream attempts, but exclude TCP/IP overhead.
  Closed sockets remain included in totals; idle intervals report zero and
  totals reset on restart. Sampling reads counters without inspecting packets
  or adding data listeners. These are observed traffic rates, not a capacity,
  latency or packet-loss test of the internal link.
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
Database initialization and blocklist persistence are in [gateway/database.js](../gateway/database.js).
The table and constraint are initialized at startup; there are no versioned migrations.
The gateway loads a bounded cache at startup and updates it after committed
changes through this page. Use a single gateway instance; direct SQL changes
require restarting it to reload the cache. Conflicting concurrent updates are
rejected and can be retried. Database initialization failures
stop startup; failed updates report an error and do not disconnect clients.
Live connection details stay in memory only. Aggregate counter samples are
stored in LevelDB; no connection history, headers, or payloads are written to
PostgreSQL.
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
