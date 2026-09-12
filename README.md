# wireproxy-awg-gui

> [Русская версия](README.ru.md)

GUI for [wireproxy-awg](https://github.com/artem-russkikh/wireproxy-awg) — a userspace AmneziaWG client (WireGuard with obfuscation) that exposes access to the tunnel as a SOCKS5/HTTP proxy.

## What is this

This is **just a wrapper**: the app itself does not establish connections or encrypt any traffic. All the actual work is done by the `wireproxy.exe` binary from the releases of the [artem-russkikh/wireproxy-awg](https://github.com/artem-russkikh/wireproxy-awg) project. The GUI provides config editing, validation, start/stop, and connection monitoring.

## How it works

```
Electron GUI (renderer + main process)
        │ 1) validate: wireproxy -n -c <conf>
        │ 2) spawn:    wireproxy -c <conf> -i 127.0.0.1:<freeport>
        │ 3) monitor:  poll the health endpoint every second
        ▼
   wireproxy.exe ──── AmneziaWG tunnel ──── SOCKS5/HTTP proxy (per config)
```

1. Before every start the config is checked in validation mode (`-n`, prints `Config OK`). On failure → state `error`, no start.
2. A free port is picked and `wireproxy.exe` is launched with `-i 127.0.0.1:<port>`, which enables the health endpoint.
3. Every second the GUI polls:
    - `GET /readyz` — 200 → `connected`, 503 → `degraded`, unreachable → `connecting`;
    - `GET /metrics` — wireguard stats (`wg show`), shown in the Metrics pane.
4. Stop is done via `kill()` on the child process (`-d` daemon mode is **not** used; the PID is tracked directly).

The result of a connection is a local SOCKS5/HTTP proxy whose address and port are set in the config (`[Socks5]` / `[http]`, `BindAddress`).

## Features

- Connection profiles (create, rename, delete, save)
- Config editor with proxy-address parsing and quick save (Ctrl+S)
- Config validation via the **Validate** button
- Start/stop, connection status and logs, live `/metrics` stats
- Configs persisted to files (not kept in memory)
- System tray with show/hide, start/stop and settings checkboxes
- Autostart on Windows login and auto-connect of the default profile on launch

## Installing dependencies

```sh
npm install
```

The app needs the `bin/wireproxy.exe` binary (it is **not** committed to git). Fetch it automatically:

```sh
npm run fetch:wireproxy
```

## Running without building (development)

```sh
npm start
```

Runs the app from source via Electron. Requires Node.js and a present `bin/wireproxy.exe` (see above).

## Building (portable exe)

```sh
npm run dist
```

Produces a self-contained `dist/wireproxy-awg GUI 1.0.0.exe`:

1. `npm run fetch:wireproxy` — downloads the pinned `wireproxy.exe` release (Windows amd64, `wireproxy_windows_amd64.tar.gz`), verifies the SHA-256, extracts it into `bin/`.
2. `electron-builder --win` — packages the app; `wireproxy.exe` is placed into `resources/bin/`, and at runtime the path is resolved via `process.resourcesPath`.

## wireproxy version

The release version is pinned **explicitly, never `latest`**, in `package.json` → `config.wireproxy`:

```json
"config": {
  "wireproxy": {
    "repo": "artem-russkikh/wireproxy-awg",
    "version": "v1.0.18",
    "asset": "wireproxy_windows_amd64.tar.gz",
    "sha256": "0b7c5e72930196b2b3e0c1d79068fad706148e4b5bbe44c8ee6374caf2c3b8b7"
  }
}
```

To upgrade, change `version` and `sha256` (take the hash from the release's `checksums.txt`).

## Profile config

INI format. Full documentation lives in the [wireproxy-awg project README](https://github.com/artem-russkikh/wireproxy-awg). Key sections:

| Section                                                                          | Purpose                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `[Interface]`                                                                    | interface params, incl. AmneziaWG obfuscation (Jc/Jmin/Jmax, S1-S4, H1-H4, I1-I5) |
| `[Peer]`                                                                         | peer key, endpoint, AllowedIPs, PersistentKeepalive                               |
| `[Socks5]` / `[http]`                                                            | SOCKS5 / HTTP(S) proxy (`BindAddress`, optional auth / CertFile / KeyFile)        |
| `[TCPClientTunnel]` / `[TCPServerTunnel]` / `[STDIOTunnel]` / `[UDPProxyTunnel]` | tunnels                                                                           |
| `[Resolve]`                                                                      | DNS strategy: `ipv4` / `ipv6` / `auto` (default `auto`)                           |

Gotchas: the top-level `WGConfig = <path>` imports an existing AmneziaWG/WireGuard config; AmneziaWG params go directly into `[Interface]`; values starting with `$` are resolved from environment variables (`$$` is a literal `$`).

## Where profiles are stored

Profiles live in `userData/profiles/` (Windows: `%APPDATA%\wireproxy-awg-gui\profiles\`):

- `index.json` — profile metadata (written atomically via tmp+rename);
- `<uuid>.conf` — the raw config text, one file per profile.

On first run a legacy `userData/wireproxy.conf` is migrated into a profile. The last remaining profile cannot be deleted.

## Repository layout

- `index.js` — Electron main process: wireproxy spawn, state machine, health polling, IPC
- `preload.js` — contextBridge (`window.wireproxyApi`), IPC channel allowlist
- `profiles.js` — profile storage (no Electron, pure Node)
- `settings.js` — app settings (`autostart`, `autoconnect`, `defaultProfileId`)
- `tray.js` — system tray (icon, dynamic menu), wired from the main process
- `renderer/` — UI in plain HTML/CSS/JS
- `scripts/fetch-wireproxy.js` — wireproxy download/extract for builds
- `electron-builder.yml` — packaging config (portable win)
- `icon.png` — app/window/tray icon
- `bin/wireproxy.exe` — the binary (not committed; generated by `fetch:wireproxy`)
- `wireproxy-awg/` — local checkout of upstream sources (gitignored, for reference)

## Requirements

- Windows (the wireproxy release binary and packaging target are Windows amd64)
- Node.js 18+ and npm to run/build from source
- Internet access during `npm run fetch:wireproxy` / `npm run dist`
