# AGENTS.md

## Project overview

Node.js GUI for the wireproxy-awg VPN tool. The tool (`wireproxy.exe`) is a userspace AmneziaWG client that exposes itself as a SOCKS5/HTTP proxy. The GUI launches and communicates with it via CLI + a local health HTTP endpoint.

## Repository structure

- `index.js` — GUI entry point (not yet implemented)
- `bin/wireproxy.exe` — prebuilt Go binary at root (DO NOT rebuild, do not delete)
- `wireproxy-awg/` — vendored upstream Go source (its own git repo). Useful for reading config format docs. Do NOT edit Go files here.

## Communicating with wireproxy.exe

### CLI flags (all that matter)

```
wireproxy.exe -c <config-path>   # required on Windows (default paths are Unix-only)
wireproxy.exe -i <host:port>     # enables health endpoint
wireproxy.exe -n                 # config validation mode only ("Config OK" on success)
wireproxy.exe -s                 # silent mode (suppresses logs)
```

### Health endpoint

When started with `-i localhost:9080` (for example):

- `GET /metrics` — wireguard daemon stats (same as `wg show`)
- `GET /readyz` — JSON with last pong timestamps from `CheckAlive` addresses; 200 when all alive, 503 when any unreachable; `{"1.1.1.1":0}` when CheckAlive not configured

### Stdout/stderr behavior

- Normal run: all log output goes to **stderr** (stdout is redirected to stderr by the exe itself)
- Daemon mode (`-d`): stdout and stderr of the child process are sent to NUL (silent, no output to capture)
- `--version` prints to **stdout**
- `--configtest` prints `Config OK` to **stdout** on success, error to **stderr** on failure

### Process management gotchas

- `-d` daemon flag spawns a detached background child. The parent returns immediately. From a GUI, use `child_process.spawn` without detached and track the child PID.
- On Windows, default config paths (`/etc/wireproxy/`, `$HOME/.config/wireproxy.conf`) do not exist. Always pass `-c` explicitly.

## Config file format

INI-style. See `wireproxy-awg/README.md` for full reference.

### Key sections

| Section             | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `[Interface]`       | WireGuard + AmneziaWG obfuscation params (Jc/Jmin/Jmax/S1-S4/H1-H4/I1-I5, etc.) |
| `[Peer]`            | Peer keys, endpoint, AllowedIPs, PersistentKeepalive                            |
| `[Socks5]`          | SOCKS5 proxy — BindAddress, optional Username/Password                          |
| `[http]`            | HTTP proxy — BindAddress, optional auth, CertFile/KeyFile for HTTPS             |
| `[TCPClientTunnel]` | Local listener → remote target via WireGuard                                    |
| `[TCPServerTunnel]` | Remote listener via WireGuard → local target                                    |
| `[STDIOTunnel]`     | stdin/stdout piped through WireGuard                                            |
| `[UDPProxyTunnel]`  | UDP proxy with BindAddress, Target, InactivityTimeout                           |
| `[Resolve]`         | DNS resolve strategy: `ipv4`, `ipv6`, `auto` (default)                          |

### Config import

`WGConfig = <path>` at the top level imports an existing AmneziaWG/WireGuard config file. AmneziaWG params go in `[Interface]` section directly.

### Environment variable interpolation

Values starting with `$` are resolved from env. Use `$$` to escape to a literal `$`.

### Config validation

Use `-n` flag: parses and validates the config file format only. Does NOT test network connectivity.

## Project conventions

- **Module system**: CommonJS (`"type": "commonjs"` in package.json)
- **No dependencies yet** — add them as needed; check existing before adding
- **No lint/format/test tooling** — none configured
- **No git repo at root** — the root project is not version-controlled; `wireproxy-awg/` is a separate git repo
- **Node.js target**: use built-in modules (child_process, http, path) where possible; keep dependencies minimal
