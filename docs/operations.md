# Operations reference

For the quick start, see the [README](../README.md).

VLESS, VMess, and Trojan over WebSocket, behind Cloudflare and Coolify.

```text
Client :443 -> Cloudflare -> Coolify -> gateway :53217 -> V2Ray
```

| Protocol | WebSocket path | Internal V2Ray port |
|----------|----------------|---------------------|
| VLESS | `/vless/<credential>` | 53217 |
| VMess | `/vmess/<credential>` | 53218 |
| Trojan | `/trojan/<credential>` | 53219 |

These WebSocket paths require an enabled, synchronized connection credential,
not a management cookie or browser Origin header. The gateway rewrites each
authorized path to the protocol's internal path. V2Ray independently validates
the protocol credential, and the IP blocklist still applies. The old shared
paths without a credential are disabled. A plain HTTP request to a correctly
shaped private tunnel path receives `426 Upgrade Required`.
Keep management routes protected separately from tunnel paths in any external
access policy.

Management HTTP endpoints are under `/api`: authentication uses `/api/auth/*`,
user management uses `/api/users`, subscription management uses `/api/connections`,
destination history search uses `/api/destinations`, IP controls use `/api/blocklist/*`, and the
status snapshot is at `/api/status.json`. The old `/auth/*`, `/blocklist/*`,
and `/status.json` paths are no longer available; update external clients and
access policies when redeploying. Browser page routes, `/healthz`, tunnel
and the `/socket.io/` WebSocket transport are unchanged.

## Deploy

1. Deploy [docker-compose.yaml](../docker-compose.yaml) in Coolify with:

   ```text
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
5. Deploy. V2Ray starts without tunnel users, with its HandlerService API on
   internal port **10085**. Never publish that port or the direct V2Ray ports.
   The management API has no authentication and must stay on the trusted
   container network. Only the gateway should be externally accessible.
6. Restrict access to the management hostname during setup, then visit
   `/register` over HTTPS and create the administrator account. The first
   registered user becomes the active administrator, so anyone who reaches an
   uninitialized deployment can claim this role.
7. On **Subscriptions**, enter a name and choose **Create subscription**. Save
   the private subscription URL and add it in v2rayNG's subscription settings.
   Update subscriptions, then connect on **port 443**.

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
  are available to active accounts; user and subscription lists are restricted to administrators.
  Sessions are rechecked before updates, and logout disconnects their sockets.
  Connection errors and stale data are shown in the UI; the client reconnects
  and resubscribes after an interruption.

Sequelize initializes `gateway_users` and `gateway_sessions` in the same
PostgreSQL database as the blocklist. The database role needs table and index
creation and read/write permissions. Preserve these tables across redeploys;
deleting all accounts allows the next registrant to become administrator.
There are no default credentials or local-file fallback.

Dashboard approval and tunnel status remain separate. Registering or activating
an account does not automatically create tunnel credentials. Administrators
create independent, named subscriptions with no per-account limit and no
dashboard-account requirement. Each subscription contains VLESS, VMess, and
Trojan profiles.

The navigation bar links to **Status**, **Blocked IPs**, and, for administrators,
**Subscriptions** and **Users**. Login and registration have their own pages. Active viewers can open
the status and blocklist pages, but management actions remain administrator-only.

The root npm workspace has separate frontend, gateway, and generator packages
with a shared lockfile. Frontend libraries such as uPlot are frontend
dependencies; Vite is a frontend development dependency. The gateway image
installs only gateway runtime dependencies and copies in the built browser
assets, not the frontend's packages.
Gateway HTTP errors use `http-errors`; session-cookie parsing uses `cookie`
without decoding token values. IP canonicalization uses `ipaddr.js`, while
strict IPv4/IPv6 input validation remains in place.

The gateway Docker build uses Node LTS/npm (`node:lts-bookworm-slim`) to install dependencies and build the
browser assets, then runs the gateway with `oven/bun:latest` as the non-root
`bun` user. Both stages use Debian for native dependency compatibility. Pull
the base image when rebuilding to pick up newer Bun releases. The generator
still uses Node. The gateway healthcheck also uses Bun.
Bun has no `lts` image tag; `latest` tracks its stable releases.
The gateway authorizes tunnels in memory and forwards WebSockets directly to
V2Ray's protocol ports. There are no intermediate proxy workers or loopback
relay ports. The gateway owns the single PostgreSQL pool (maximum two
connections), accounts, blocklist, realtime clients, and history store;
establishing a tunnel does not query that pool.
Blocking an IP or disabling a tunnel closes its gateway sockets across
all routes. Active sockets are indexed by subscription, so concurrent-IP checks,
subscription IP lists, and targeted disconnects inspect only that subscription's
sockets. Closed sockets are removed from the index, and empty entries are deleted.
These checks do not add work to forwarded data chunks.
Dashboard tunnel counters and throughput still measure the
client-facing sockets; the gateway emits upstream throughput logs per protocol.
Process CPU/memory metrics describe the gateway process, not V2Ray. Shutdown
closes all proxied tunnels. No additional ports should be published.
For a non-Docker setup, install Node/npm for the build and Bun for the gateway:

```bash
npm ci
npm run build
# Set DATABASE_URL, V2RAY_HOST, V2RAY_API_ADDRESS, and
# GATEWAY_SECURE_COOKIES=false only for local HTTP:
bun gateway/server.js
```

Rebuild after frontend changes. Source is in [frontend](../frontend); generated
`gateway/public` assets are not committed.

For frontend development, start the gateway with `DATABASE_URL`, `V2RAY_HOST`,
`V2RAY_API_ADDRESS`, and
`GATEWAY_SECURE_COOKIES=false`, then run `npm run dev` in another terminal.
Open the Vite URL it prints (normally `http://127.0.0.1:5173`). Vite proxies
management API and Socket.IO requests to the local gateway on port 53217,
preserving the browser's host for same-origin checks. If the gateway port changes, update the
proxy target in [frontend/vite.config.js](../frontend/vite.config.js). Both
servers must be running; the gateway still requires PostgreSQL. Do not expose
the HTTP development server or disable secure cookies in production.

## Independent subscriptions and live controls

The administrator's **Subscriptions** page provides:

- **Create subscription:** enter a 1-128 character name and generate unique
  credentials and a private subscription. Names need not be unique. There is no
  application-level subscription count limit.
- **Rename:** change the subscription's display name (1-128 characters) without
  changing its URL, credentials, IP limit, traffic totals, or active tunnels.
- **Pause:** reject new tunnels and close that subscription's existing gateway sockets.
- **Resume:** restore access with the same profiles.
- **Reset credentials:** invalidate old profiles and the old subscription URL.
  Resetting a paused connection does not resume it.
- **Reset traffic totals:** after confirmation, zero only this subscription's
  accumulated core upload/download totals. Current V2Ray counters are checkpointed
  in the same durable write, so only new traffic is added afterward, including
  after a gateway restart. Credentials, active tunnels, IP limits, live gateway
  rates, and other subscriptions are unchanged. If sampling or persistence fails,
  the action returns HTTP 503 without changing the saved totals; retry after
  resolving the error.
- **Replace subscription URL:** issue a new URL without changing tunnel
  credentials; the old URL stops updating, but cached profiles still work.
- **Delete subscription:** after confirmation, disable access, close its tunnels,
  remove credentials from all three V2Ray protocols, and permanently delete the
  record. Its URL and cached profiles stop working. If cleanup fails, an error
  is shown and the record stays disabled; retry deletion after resolving the error.
- **Concurrent IP limit:** set at creation or edit with **Save limit**.
  `0` means unlimited and is the default for new subscriptions.
  The gateway counts distinct normalized client IPs with open tunnels for that
  subscription across all three protocols, including pending handshakes.
  A new IP receives HTTP 429 when the limit is reached; existing IPs may open
  more tunnels. A slot is released when that IP's last tunnel closes.
  Lowering the limit keeps existing tunnels/IPs connected and rejects new IPs
  until the active count drops below the new limit. Pausing or deleting releases
  the subscription's slots. Other subscriptions have independent limits.

For Coolify/Traefik connections without Cloudflare, configure
`GATEWAY_TRUSTED_PROXIES` with Traefik's gateway-network IP (or a narrowly scoped
CIDR). It accepts a comma-separated list; empty means no forwarded-header trust.
Malformed entries stop startup. The gateway walks `X-Forwarded-For` from right
to left through trusted proxies, stopping at the first untrusted address. Invalid
forwarded addresses are logged and ignored. Requests from other peers cannot
override their socket IP. Use the same resolved address for status, connected IPs,
blocklist enforcement, and concurrent-IP limits. Existing tunnels retain the IP
captured at connection time; reconnect them after changing this setting.

Keep the gateway port private. Configure Traefik to discard untrusted incoming
forwarded headers; do not enable `forwardedHeaders.insecure`. Trust only actual
proxy addresses, not all private networks. Docker-assigned proxy IPs can change
after network recreation, so recheck the configured address on redeploy.
`GATEWAY_TRUST_CLOUDFLARE_HEADERS` defaults to `auto`: `CF-Connecting-IP` and
`CF-IPCountry` are accepted only if the socket peer, or source resolved through
trusted proxies, is in Cloudflare's published IPv4/IPv6 ranges. Otherwise the
forwarded or socket IP is used, even if Cloudflare headers are present.
Keep those ranges in `gateway/services/client-ip.js` current.
`false` disables Cloudflare metadata. `true` retains legacy Cloudflare-only
trust when no trusted proxies are configured, and in that case still requires
restricting origin access to Cloudflare and trusted proxies. Existing deployments
with an explicit `false` must switch to `auto` to enable automatic detection.

IP limits are not physical-device limits: devices behind NAT share a slot,
and IPv4/IPv6 or changing addresses can use multiple slots for one device.
Client IPs come from the peer socket, trusted `X-Forwarded-For`, or validated
`CF-Connecting-IP` when Cloudflare is detected, as described above.
Behind Cloudflare, use a correctly configured proxy
trust boundary; otherwise the limit
counts proxy IPs or can be bypassed with forged headers. Limited subscriptions
reject tunnels if no client IP is available. The limit is enforced at the gateway,
not inside V2Ray; keep direct V2Ray ports inaccessible.

Subscription URLs have the form `https://<V2RAY_HOST>/subscriptions/<token>`.
They return a Base64-encoded list of share links, without dashboard login.
New tokens are cryptographically generated UUID v4 values (36 characters).
Existing 64-character hexadecimal tokens remain valid until replaced or reset.
The token and its SHA-256 lookup hash are
persisted so the current URL remains visible and copyable in the administrator's
responsive subscription cards, including after reloads. URLs are included in administrator-only
subscription lists and realtime snapshots, not public status data.
On upgrade, a nullable token column is added without changing existing URLs.
Older hash-only subscriptions keep working, but their URLs cannot be recovered;
the Subscriptions page prompts for a one-time replacement to make a new URL displayable.
Keep subscription URLs and exported profiles private, and disable proxy access
logging for `/subscriptions/*` and private tunnel paths. Exclude these paths
from caching, browser challenges, and external dashboard-login requirements.

Sequelize creates `gateway_tunnel_connections` in PostgreSQL. It stores the
subscription name, tunnel credential, subscription token and hash, desired enabled
state, concurrent IP limit, and synchronization status/error. Tunnel credentials and subscription
tokens are stored as recoverable secrets; restrict and back up this database
accordingly. Do not delete
connection records directly: use Pause to revoke runtime access or Delete subscription
to remove them safely.
On upgrade from account-linked connections, a transaction adds names from the
former account usernames and removes the account column, including its unique
and foreign-key constraints. Existing record IDs, credentials, subscription
tokens/hashes, and enabled states are preserved. Back up PostgreSQL before
upgrading. Dashboard account approval is unchanged and no longer affects
subscription creation.

Changes use V2Fly HandlerService AddUser/RemoveUser operations for each protocol.
No container restart or Docker socket is needed. A private credential-bearing
gateway path lets the gateway close only the affected subscription's sockets and reject
cached profiles immediately. An empty subscription alone would not revoke access.
The credentials and private paths are bearer secrets, not device identities.
Expiration, traffic quotas, and physical-device identification are not implemented.

The gateway reconciles desired database state at startup and every 15 seconds,
restoring credentials after V2Ray restarts. Failed updates return HTTP 503 and show
an error in Subscriptions; affected connections remain blocked until a retry succeeds.
A failed action may have saved its desired state, so inspect its status before
retrying. Only one gateway may manage a V2Ray instance; multi-instance
coordination is not supported.

Tunnel authorization reads a plain in-memory credential snapshot populated by
successful synchronization. Create, pause/resume, reset, delete, and concurrent-IP
limit changes update or invalidate the affected entry before the action completes.
Authorization-changing actions block new tunnels while in progress; failed writes
or synchronization do not leave the previous cached credential usable.
Unknown credentials are rejected without a database lookup. A failed reconciliation
clears the snapshot and returns HTTP 503 for new tunnels until a refresh succeeds;
it does not by itself disconnect established streams. Individual synchronization
failures block only the affected subscription. Shutdown disables authorization.
Direct SQL changes are picked up by the next reconciliation, not immediately;
use gateway controls when immediate revocation is required.

### Per-subscription activity and core accounting

The administrator-only `/api/connections`/Socket.IO `connections` snapshots expose
two separate measurements. Subscription cards show these statistics, connected
IPs, management controls, URLs, and status without explanatory panels. Saved
traffic totals and previous activity remain visible when no tunnels are open:

- Activity badges show green **Online** for one or more open gateway tunnels,
  red **Offline** for zero, or gray **Status unknown** when realtime updates fail.
  They update with the live snapshots and remain separate from Enabled/Paused
  and credential synchronization status. Online indicates an open socket, not
  proof of successful protocol authentication or Internet reachability.
- `connections[].gateway.openTunnels`: every currently open gateway socket for
  that subscription, including sockets beyond the Status page's 1,000-detail limit.
  One device may open many sockets. These counts are not device counts and do
  not establish that the protocol handshake succeeded.
- `connections[].gateway.connectedSince`: the oldest currently open socket's
  connection time, or null when no sockets are open. Closing that oldest socket
  advances this timestamp to the next oldest.
- `connections[].gateway.lastConnectedSince`: the live connected-since value,
  or the saved start time of the previous connection when offline. This saved
  value does not imply that pre-restart sockets are still connected.
- `connections[].gateway.traffic`: socket upload/download bytes and rates from
  the shared five-second sampler. Upload is client to gateway; download is
  gateway to client. Rates include recently closed sockets in the sampling
  interval and include WebSocket framing/handshake overhead.
- `connections[].gateway.lastTrafficAt`: when a sample or socket close last
  observed a byte-counter change. It is an observation timestamp, not an exact
  packet timestamp or proof of authenticated application traffic. It remains
  available in snapshots after all sockets close and is restored from SQLite after a restart.
- `connections[].coreTraffic`: authenticated V2Ray `uploadBytes`/`downloadBytes`
  totals, aggregated across VLESS, VMess, and Trojan using the connection's
  stable internal subscription identifier. Byte totals are decimal strings in the API
  to preserve 64-bit precision.

The `gateway_subscription_activity` SQLite table stores each subscription's
`lastTrafficAt` and last observed `connectedSince`. The existing five-second
collection loop saves these independently of V2Ray statistics availability and
flushes them on graceful shutdown. Short-lived connections retain their start
time in the sampler until saved. A crash can lose changes since the last
successful save. Write failures are logged and surfaced on Subscriptions.
Deleting a subscription removes its saved activity. Reset traffic totals does
not erase timestamps. Current tunnel counts, IPs, and speeds remain live and
are not restored as active connections.

Gateway ownership is determined by the private path; V2Ray accounting is
determined by the protocol credential. They are separate attribution mechanisms,
not independent proof of a physical user's identity. Only administrators receive
the per-subscription activity and accounting snapshots. `/api/users` and the
Socket.IO `users` resource contain dashboard accounts only.

### Recent destination domains

The administrator-only subscription cards and `/api/connections`/Socket.IO
`connections` snapshots include `connections[].recentDestinations`, a list of
up to 50 `{ domain, lastSeen }` entries ordered by most recent observation.
The separate administrator-only **Destinations** tab searches all retained
subscription/domain pairs, not just those card previews. Its columns are
**Domain**, **Subscription**, and **Last observed**. Search matches literal,
case-insensitive substrings of a domain or the current subscription name.
Previous/Next browse 50-row pages; Search and Refresh return to the newest page.
The page fetches only on those actions, not per keystroke or on a polling timer.
Administrators can change **Domain retention (hours)** on this page. The setting
is a positive whole number, defaults to 24, applies to all subscriptions and
previews, and persists across gateway restarts in `gateway_destination_settings`
in `metrics.sqlite`. Resource chart retention is unchanged.

`POST /api/destinations/retention` accepts JSON `{ "hours": 48 }` and returns
`{ "destinationRetentionHours": 48 }`. It requires an active administrator and
a same-origin request. Invalid, missing, fractional, non-positive, or numerically
unsafe values return HTTP 400. Changes affect reads immediately and trigger
expiry cleanup on the next collection cycle. Shortening retention expires older
history; increasing it cannot restore history already deleted.

`GET /api/destinations?q=<search>&cursor=<nextCursor>` requires an active
administrator. Both parameters are optional; `q` is limited to 253 characters.
The response contains `destinations` with `{ subscriptionId, subscriptionName,
domain, lastSeen }`, `nextCursor` (null at the end), `destinationStats`, and
`destinationRetentionHours`. Connection snapshots also include
`destinationRetentionHours` so subscription previews display the current window.
Pagination uses a validated opaque cursor over last-observed time, subscription
ID, and domain rather than loading the full history, counting all matches, or
using growing SQL offsets. Each query returns at most 51 rows to determine
whether another page exists, using the existing indexes without adding index
maintenance to domain writes. Names come from current subscription metadata,
so renames are reflected immediately and deleted subscriptions are excluded.
Results are live, not a frozen snapshot: activity can move an entry to an earlier
page, and expiry can remove entries while browsing. Refresh to see the newest
ordering. Do not retain search/cursor query strings in external access logs.

`lastSeen` is the gateway's observation time, not the user's last page interaction.
Domains are plain text, not clickable links. Background applications, prefetching,
and failed outbound connections may appear; an accepted protocol request is not
proof that a website loaded. HTTPS paths, queries, and content are not collected.
IP-only destinations, hidden hostnames/ECH, and traffic outside this proxy cannot
be reconstructed. HTTP/TLS hostname sniffing improves coverage but is not complete.

Managed generation enables V2Fly `LoggerService.FollowLog` on the existing
private management API and `policy.system.overrideAccessLogDest` so access events
use the destination after hostname sniffing. The collector accepts only
authenticated `accepted` events with the gateway-assigned `connection-<id>` email.
Do not expose management port 10085 publicly. No access-log file or extra proxy
hop is added; managed access-log output is disabled while the API stream is used.
`FollowLog` is an upstream unstable API: use a V2Fly build supporting that RPC
and logging policy. Unsupported versions report a collection warning rather
than silently showing an empty history.

An independent collection loop coalesces repeated observations of each
subscription/domain in a bounded 10,000-entry buffer into one SQLite upsert.
Collection cycles wait five seconds after completion; they never overlap and
do not delay scheduling of core byte totals or activity sampling. Domain writes run
outside the credential-management queue rather than occupying it during domain
persistence. Authorization remains synchronous and does not access SQLite.
Deletion waits for any in-flight
domain write and excludes that subscription from new batches before clearing
its history, preventing delayed writes from recreating deleted records.
Upserts and cleanup use transactions of at most 500 rows, yielding between batches
so other work can run and acquire the SQLite writer. Idle cycles between cleanup
passes perform no destination writes. Expiry cleanup runs at most once per minute; orphan cleanup
runs only when the subscription ID set changes. The
`gateway_subscription_destinations` table lives in the existing `metrics.sqlite`.
An entry expires the configured number of hours after its last observation; reads exclude expired rows,
and cleanup deletes them and orphaned subscriptions' rows.
Deletion of a subscription removes its history. Pause, credential rotation, and
Reset traffic totals do not erase domain history. Saved history survives restarts
within retention. No historical access logs are imported.

Top-level `destinationStats` reports collection status/error separately from
core byte totals. Stream failures reconnect after five seconds, storage failures
retain a bounded retry buffer, and overflow is logged and shown as incomplete
collection. Collection does not block tunnel authorization. Disconnections,
gateway downtime, buffer overflow, and crashes before a flush can lose observations;
the stream has no replay. Collection timestamps use the gateway clock.
Inform subscribers of this monitoring, restrict administrator access, and protect
SQLite files and backups. Expiry removes active records, not copies in backups.
Rebuild/redeploy **init, V2Ray, and gateway** together to apply the new configuration.

Managed configuration enables `StatsService`, the stats manager, and level-zero
`statsUserUplink`/`statsUserDownlink` policies. Redeploy `init` and V2Ray when
upgrading to install that configuration. The gateway polls QueryStats and
GetSysStats without resetting counters, about every five seconds, once globally
rather than per dashboard viewer. Top-level `coreStats` contains status, the
last successful sample time, core uptime, and any collection error. Failed reads
show a warning; cached totals remain explicitly stale, or unavailable if nothing
has been collected. Statistics failures do not pause working connections.

Core totals accumulate in embedded SQLite through Sequelize and survive gateway
and V2Ray restarts, credential resets, and pause/resume. The
`gateway_traffic_checkpoints` table stores totals and raw-counter checkpoints together
in a committed transaction after each successful sample. Each update acquires an
immediate write transaction and reloads the committed checkpoint before computing
deltas, preventing concurrent writers from overwriting a stale cached checkpoint.
Out-of-order samples are rejected rather than being counted as resets. V2Ray uptime and
RPC timing identify process restarts, including restarts while the gateway is
offline; lower raw counters are also treated as counter resets. Repeated samples
and gateway restarts do not count the same bytes twice.

The first sample imports the currently available V2Ray counters. Earlier usage
already lost to a core reset cannot be recovered. Neither can traffic between the
last successful sample and a V2Ray reset, including during collection/storage
outages. These are sampled accumulated totals, not exact billing records.
Read/write failures surface a warning and keep the last saved totals stale rather
than displaying zeros. Persisted totals load even if V2Ray is initially unavailable.
Deleting a subscription removes its saved usage; orphaned entries are also
removed on the next successful sample.

Preserve and back up the `gateway-metrics` volume at `GATEWAY_METRICS_PATH`.
Accumulated totals are not subject to the charts' 24-hour retention. Removing that
volume loses the accumulated totals and checkpoints. SQLite uses local file locks
and bounded retries for `SQLITE_BUSY`; only one writer commits at a time.
The metrics database uses WAL mode so readers can proceed alongside a writer;
write durability is not reduced. Use a SQLite-aware backup/snapshot procedure,
not a copy of only the live `metrics.sqlite` file: uncheckpointed data may still
reside in its `-wal` sidecar.
Do not share the database over a network filesystem. The application still
requires one gateway owner per V2Ray instance: SQLite does not coordinate
in-memory IP limits, live sockets, or V2Ray credential reconciliation.
Gateway socket metrics remain in memory; no per-subscription timers are added.

The SQLite upgrade starts a fresh `metrics.sqlite` file in the existing metrics
directory. Old LevelDB files are left untouched and are not imported. Charts
start empty and accumulated totals begin with the currently available V2Ray
counters; PostgreSQL accounts, subscriptions, and credentials are unchanged.

Admin-only, same-origin POST endpoints:

- `/api/connections` with JSON body `{ "name": "Subscription name", "maxConcurrentIps": 0 }`
  (`maxConcurrentIps` is optional and defaults to `0`)
- `/api/connections/:id/pause`
- `/api/connections/:id/resume`
- `/api/connections/:id/reset`
- `/api/connections/:id/reset-stats`
- `/api/connections/:id/subscription`
- `/api/connections/:id/delete` (returns `{ "deleted": true }` after cleanup)
- `/api/connections/:id/rename` with JSON body `{ "name": "New subscription name" }`
- `/api/connections/:id/limits` with JSON body `{ "maxConcurrentIps": 2 }`
  (required integer from `0` to `2147483647`; `0` disables the limit)

Administrator API subscription lists and realtime snapshots include `maxConcurrentIps`,
`activeIps`, and `connectedIps` (a sorted, deduplicated list of normalized IP
addresses with open tunnels). Subscription cards show these details alongside
the editable limit; `0` means unlimited.
The API uses the same socket registry
as limit enforcement, includes all three protocols, and excludes destroyed or
blocked sockets. These addresses are not persisted as connection history.
Limits persist in PostgreSQL; active slots are held only while
gateway sockets are open and are cleared on restart.

The old `/api/users/:id/connection` creation endpoint is removed. Use the
admin-only `GET /api/connections` endpoint to list independent subscriptions.

For local development set `V2RAY_HOST` to the public hostname and
`V2RAY_API_ADDRESS` to the reachable internal gRPC address (default:
`v2ray:10085`). Run V2Ray with a managed configuration generated by `init`
with `V2RAY_MANAGED=true`. Keep the API private even in development.

### Migration from shared profiles

Redeploy all services, including `init`, to replace the old persisted server
configuration. Compose enables managed mode and no longer uses `V2RAY_UUID`
or FTP exports. Existing shared credentials and bare protocol paths stop working.
Create private subscriptions for users and remove old FTP exports and client
profiles manually. Shadowsocks is no longer supported.

## Offline credential generation

```bash
npm ci
npm run rotate -- ws.hesamian.com

# Or choose the UUID:
npm run rotate -- ws.hesamian.com --uuid <uuid>
```

This writes standalone local server/client configs and protocol exports.
It does not change deployed subscriptions. Use Subscriptions to reset those.
Existing local configs must already use WebSocket; regenerate old configs
from templates if necessary.

## DNS poisoning protection

The generated server uses encrypted DNS over HTTPS to Cloudflare and Google,
addressed by IP so resolver hostnames do not need a bootstrap DNS lookup.
Its `freedom` outbounds use `UseIP` to use V2Ray's built-in DNS rather than
leaving destination resolution to the system resolver. Server DoH uses
`https+local://` because it must leave the server directly, not re-enter routing.
DoH endpoints must be reachable from the server with valid TLS certificates.
V2Fly can fall back to the system resolver if built-in resolution fails; this
is not a fail-closed DNS policy. Keep the server's system resolver trusted and
investigate DNS resolution errors rather than relying on that fallback.

VLESS, VMess, and Trojan inbounds recover visible HTTP Host/TLS SNI hostnames.
If a client sends a poisoned IP together with a recoverable hostname, V2Ray
replaces the IP with that hostname and resolves it again on the server.
This only helps traffic that reaches the tunnel. It cannot recover an absent or
encrypted hostname (for example ECH), and sniffing can delay server-first
protocols such as SMTP. It is not a substitute for protecting client DNS.

Generated standalone client JSON configs use DoH through their primary proxy
outbound. The `proxy-dns` tag and first routing rule keep built-in DNS queries
inside the tunnel, ahead of direct/private-IP rules. Local SOCKS/HTTP inbounds
also recover HTTP/TLS hostnames before routing. Applications should pass domains
to SOCKS (`socks5h`/remote DNS), rather than resolving them with the OS first.
These JSON configs are separate from managed connection-link subscriptions.

For **v2rayNG connection-link subscriptions**, configure the app separately
(setting labels vary by release):

1. Use VPN mode and enable its local/core DNS handling so Android DNS requests
   are intercepted, rather than sent to the ISP outside the tunnel.
2. Set remote DNS to `https://1.1.1.1/dns-query` (or
   `https://8.8.8.8/dns-query`), and ensure remote DNS traffic uses the proxy.
   Do not use `https+local://` on the client: that bypasses the tunnel.
3. Enable HTTP/TLS sniffing with destination override, not route-only sniffing.
   For diagnosis, use global/proxy-all routing; direct/local DNS rules must not
   handle filtered domains.
4. Restart the VPN and clear stale DNS/browser connections. Inspect the exported
   runtime config: DNS must not fall back to plaintext/system DNS for filtered
   names. A list containing only `1.1.1.1`/`8.8.8.8` is unencrypted DNS, not DoH.

Share links cannot configure VPN DNS interception, Android Private DNS,
browser-specific secure DNS, or arbitrary app routing. The proxy hostname must
also resolve correctly for the initial tunnel connection; tunneled DNS cannot
bootstrap a tunnel whose own address is already poisoned. Neither DoH nor
sniffing guarantees access when the proxy or resolver endpoints are blocked.

To apply server changes, rebuild/redeploy `init` and `v2ray` together with the
gateway. `init` regenerates the persisted server configuration; rebuilding only
the gateway leaves the old V2Ray DNS settings in place. Do not delete the config
volume or reset subscription credentials. Regenerate standalone client JSON
configs separately; existing managed links remain valid.

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
  Samples are kept in embedded SQLite through Sequelize for 24 hours across gateway
  restarts, then deleted; they are not kept as a full history in application memory.
  Indexed numeric timestamps replace padded string keys, and history reads use
  bounded, ordered batches before aggregating chart buckets. The Docker volume
  `gateway-metrics` must be preserved across redeploys and writable by the
  container's `bun` user. It stores gateway CPU, memory, proxy throughput, and
  connection   counter samples and persistent subscription traffic checkpoints.
  For non-Docker use, `GATEWAY_METRICS_PATH` overrides the default
  `./data/resource-history` directory; the database file is `metrics.sqlite`
  inside that directory. Back up the volume with the gateway stopped, or use
  SQLite's online backup facilities. Database open and write failures are logged;
  the dashboard reports recording errors and failed history requests.
- **Status:** `https://v2ray.hesamian.com` (or `/status` on the gateway).
  Socket.IO pushes connection, blocklist and user changes, along with periodic
  snapshots. Status includes active tunnels, attempts, and errors by protocol
  and country, plus aggregate proxy upload and download throughput.
  Protocol and country tables hide rows whose open sockets, connection attempts
  and proxy failures are all zero; the JSON snapshot retains all counters.
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
  detail state without scanning the subscription's remaining sockets. The final
  closing socket preserves its timestamp for the subscription's last-active display.
  Omitted client sockets retain owner/time and sampling baselines
  for per-subscription aggregates, but not individual speed details. Upstream sockets
  keep only aggregate byte-counter baselines.
  The selected group stays expanded across refreshes. `/api/status.json` provides
  both grouped summaries and individual connections. At most **1,000 active
  connection details** are retained, with User-Agent text limited to 256 characters.
  Closed connections are removed immediately; no connection history, request
  headers, or payloads are stored in status memory. When details are omitted,
  the page warns that IP groups cover only displayed sockets; protocol/country
  totals still count all connections.
  IP groups also show approximate city/region/country and ISP names from
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
  the `protocol` (`vless`, `vmess`, or `trojan`),
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
IP blocking is not device identification: people may share an IP or change IPs.
Per-user credentials identify access to a connection, not individual devices.

The list is limited to **1,000 IPs**, with no automatic eviction. Sequelize
uses PostgreSQL to store it in `gateway_ip_blocklist` via `DATABASE_URL`; the database role
needs permission to create, alter, and update that table. There is no local-file fallback.
PostgreSQL initialization is in [gateway/database/postgres/connection.js](../gateway/database/postgres/connection.js).
Each entity owns its model and database operations in
[gateway/database/postgres](../gateway/database/postgres): `users.js`, `sessions.js`,
`blocked-ips.js`, and `tunnel-connections.js`. Sequelize/SQLite metrics storage is in
[gateway/database/sqlite](../gateway/database/sqlite): `resource-history.js` and
`traffic-usage.js`. Each database folder has its own `index.js` barrel; the shared
[database entry point](../gateway/database/index.js) re-exports both barrels.
Authentication and tunnel-control
services use these repositories rather than issuing database queries directly.
Gateway services live in [gateway/services](../gateway/services).
Public folder entry points collect exports for extensionless directory imports
such as `import { normalizeIp } from '../services'`. Bun resolves these imports
to the folder's `index.js`; native Node.js ESM does not support this syntax.
Sibling imports remain direct to avoid barrel-import cycles and loading unrelated
services into lightweight modules.
Gateway collection transformations use `import lodash from 'lodash'` and
qualified calls such as `lodash.map(...)` and `lodash.sortBy(...)`. Keep native Map/Set operations and
locale-aware comparator sorts when replacing them would change behavior.
The server and health-check entrypoints remain in `gateway`.
HTTP routes are grouped by resource in [gateway/controllers](../gateway/controllers).
Controllers serve the frontend pages and dashboard APIs; services retain
authentication, account operations, V2Ray management, and shared metrics.
Proxy transport lives in [gateway/proxy](../gateway/proxy). It owns upstream routing,
WebSocket upgrades, socket tracking/disconnection, proxy errors, throughput
logging, and the subscription endpoint used by V2Ray clients.
[gateway/app.js](../gateway/app.js) composes the frontend and subscription routes
with shared security headers and error handling. Existing authentication,
same-origin checks, body-size limits, and rate limits remain in place.
Missing tables are initialized at startup with Sequelize `sync()`. The blocklist
model's `afterSync` hook creates `gateway_ip_blocklist_host_check` only when it is
missing, enforcing host-only IPv4 and IPv6 addresses. Constraint inspection or
creation failures stop startup. Legacy subscription schema upgrades are no
longer performed; existing deployments must already have those changes applied.

The gateway loads a bounded cache at startup and updates it after committed
changes through this page. Use a single gateway instance; direct SQL changes
require restarting it to reload the cache. Conflicting concurrent updates are
rejected and can be retried. Database initialization failures
stop startup; failed updates report an error and do not disconnect clients.
Live connection details stay in memory only. Aggregate counter samples are
stored in SQLite; no connection history, headers, or payloads are written to
PostgreSQL.
Behind Cloudflare, enable trusted client headers as described below, or the
blocked address may be your reverse proxy rather than an individual client.

Gateway socket counters reset on restart; persisted core traffic totals do not.
Open tunnels and healthy listeners do not prove
authenticated browsing works. An IP may represent multiple users or devices;
each connection ID identifies a socket and changes on reconnect. User-Agent
may hint at an app or device but can be missing or spoofed.
Device models cannot be reliably detected. Rows disappear when sockets close.
The page and JSON expose full client IPs and User-Agents to active management
accounts. Limit account approvals and restrict management routes separately
from tunnel paths when appropriate. Credentials are not shown.

For country counters and real client IP logs, enable Cloudflare IP Geolocation
and preserve `CF-Connecting-IP` / `CF-IPCountry`. The default
`GATEWAY_TRUST_CLOUDFLARE_HEADERS=auto` detects Cloudflare from its source IP ranges,
not merely the presence of a header.
For mixed Cloudflare and direct traffic through Traefik, configure
`GATEWAY_TRUSTED_PROXIES` as described under concurrent-IP limits. Direct traffic
then uses the forwarded client IP without trusting spoofed Cloudflare metadata.
Without verified Cloudflare metadata, country is Unknown and logs use the
trusted forwarded client IP or socket peer IP. Restrict access
to IP logs and configure retention.

If v2rayNG connects but browsing fails, ensure its local SOCKS port matches
**10808**, re-import the updated profile, and restart the VPN.
