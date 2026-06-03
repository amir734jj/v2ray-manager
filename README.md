# v2ray multi-protocol server

Single Docker container running three protocols simultaneously.

## Protocols

| Folder   | Protocol | Port        | Transport                        |
|----------|----------|-------------|----------------------------------|
| `vless/` | VLESS    | 53217 TCP   | Raw TCP, no TLS                 |
| `vmess/` | VMess    | 53218 TCP   | HTTP obfuscation (Host: www.bing.com) |
| `trojan/`| Trojan   | 53219 TCP   | Raw TCP, no TLS                  |

## Files

```
v2ray-all/server.json   — merged server config (all 3 inbounds)
docker-compose.yml      — single-container deployment
rotate-id.mjs           — UUID rotation script

vless/
  connection.txt        — current vless:// share URL
  qr.png                — QR code for mobile import

vmess/
  connection.txt        — current vmess:// share URL
  qr.png                — QR code for mobile import
  client.json           — ready-to-use v2ray client config

trojan/
  connection.txt        — current trojan:// share URL
  qr.png                — QR code for mobile import
```

## Rotating credentials

```bash
# Rotate UUID (server address read from existing connection.txt)
npm run rotate

# Rotate UUID and set a new server address
npm run rotate -- <server-ip-or-hostname>

# Remove all generated credential files
npm run clean
```

Updates on every rotate:
- `v2ray-all/server.json` — new UUID in all inbound clients
- `vless/connection.txt` + `vless/qr.png` + `vless/client.json`
- `vmess/connection.txt` + `vmess/qr.png` + `vmess/client.json`
- `trojan/connection.txt` + `trojan/qr.png` + `trojan/client.json`

Then restart the container to apply:

```bash
sudo docker compose restart
```
