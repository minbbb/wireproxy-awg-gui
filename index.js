const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const profiles = require('./profiles');
const settings = require('./settings');
const chains = require('./chains');
const { UdpOverSocksRelay } = require('./relay');
const TrayController = require('./tray');

const WIREPROXY_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'wireproxy.exe')
  : path.join(__dirname, 'bin', 'wireproxy.exe');

const STATE_LABEL = {
  stopped: 'Stopped',
  validating: 'Validating...',
  connecting: 'Connecting...',
  connected: 'Connected',
  degraded: 'Connected (degraded)',
  error: 'Error',
};

const DERIVED_CONF_DIRNAME = 'chain-run';
const SKIPPED_ROUTINE_SECTIONS = [
  'http',
  'tcpclienttunnel',
  'tcpservertunnel',
  'stdiotunnel',
  'udpproxytunnel',
];

let mainWindow = null;
// hops[] — ordered list of running wireproxy instances (a chain). Each hop:
// { profileId, name, proc, healthPort, confPath, socksPort|null, socksAddr|null, derivedConfPath|null, relay|null }
let hops = [];
let state = 'stopped';
let activeIds = [];
let chainId = null;
let healthTimer = null;
let runDir = null;
let trayCtrl = null;
let quitting = false;
// Bumped by every operation that invalidates the current run (new start, stop,
// unexpected hop exit, profile delete). The startup loop in startRun aborts when
// its captured token no longer matches, so a superseded run never touches a
// newer run's hops.
let runToken = 0;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function log(line) {
  sendToRenderer('vpn:log', { line });
}

function setState(newState) {
  state = newState;
  sendToRenderer('vpn:status', {
    state,
    activeProfileId: activeIds[activeIds.length - 1] || null,
    activeIds,
    chainId,
  });
  if (trayCtrl) trayCtrl.sync();
}

function syncTray() {
  if (trayCtrl) trayCtrl.sync();
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function removeFile(p) {
  try {
    fs.unlinkSync(p);
  } catch {}
}

function runConfigTest(configPath) {
  return new Promise((resolve) => {
    const proc = spawn(WIREPROXY_PATH, ['-n', '-c', configPath], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function httpGet(httpPath, port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: httpPath, timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: body.trim() }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

async function pollHealth() {
  if (hops.length === 0) return;
  const report = [];
  let alive = false;
  let unreachable = false;
  let degraded = false;
  for (const h of hops) {
    if (!h.proc || h.proc.exitCode !== null) continue;
    alive = true;
    const readyz = await httpGet('/readyz', h.healthPort);
    if (!h.proc || h.proc.exitCode !== null) return;
    report.push({
      profileId: h.profileId,
      name: h.name,
      status: readyz.status || readyz.error,
      body: readyz.body || '',
      socksPort: h.socksPort || (h === hops[hops.length - 1] ? parseSocksPort(profiles.get(h.profileId)?.content || '') : null),
      socksAddr: h.socksAddr || (h === hops[hops.length - 1] ? parseSocksAddr(profiles.get(h.profileId)?.content || '') : null),
    });
    if (readyz.error) unreachable = true;
    else if (readyz.status === 503) degraded = true;
  }
  if (!alive) return;
  if (unreachable) setState('connecting');
  else if (degraded) setState('degraded');
  else setState('connected');
  sendToRenderer('vpn:readyz', { hops: report });
  const exit = hops[hops.length - 1];
  if (exit && exit.proc && exit.proc.exitCode === null) {
    const metrics = await httpGet('/metrics', exit.healthPort);
    if (!exit.proc || exit.proc.exitCode !== null) return;
    if (!metrics.error && metrics.status === 200) {
      sendToRenderer('vpn:metrics', { text: summarizeMetrics(metrics.body) });
    }
  }
}

function startHealthPolling() {
  stopHealthPolling();
  healthTimer = setInterval(pollHealth, 1000);
}

function stopHealthPolling() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

function stopHop(h) {
  if (h.relay) {
    try { h.relay.stop(); } catch {}
    h.relay = null;
  }
  if (h.derivedConfPath) {
    const p = h.derivedConfPath;
    if (h.proc && h.proc.exitCode === null) {
      h.proc.once('exit', () => removeFile(p));
    } else {
      removeFile(p);
    }
    h.derivedConfPath = null;
  }
  if (h.proc && h.proc.exitCode === null) {
    try {
      h.proc.kill();
    } catch {}
  }
}

function onHopExit(hop, code) {
  log('[gui] hop "' + hop.name + '" exited (code ' + code + ')');
  if (hop.relay) {
    try { hop.relay.stop(); } catch {}
    hop.relay = null;
  }
  const idx = hops.indexOf(hop);
  if (idx === -1) return;
  if (state === 'validating') {
    // Startup still in progress: let the startRun loop raise the real error
    // via its liveness checks, so the user sees the cause, not a generic stop.
    hops.splice(idx, 1);
    return;
  }
  // Steady state: a chain is only valid as a whole, so one dead hop kills the run.
  runToken++;
  const rest = hops;
  hops = [];
  for (const h of rest) stopHop(h);
  stopHealthPolling();
  activeIds = [];
  chainId = null;
  setState('stopped');
}

async function stopCurrent() {
  const old = hops;
  hops = [];
  const exits = old.map((h) => {
    if (h.proc && h.proc.exitCode === null) {
      return new Promise((resolve) => h.proc.once('exit', resolve));
    }
    return Promise.resolve();
  });
  for (const h of old) stopHop(h);
  await Promise.all(exits);
  stopHealthPolling();
}

function stopVpn() {
  runToken++;
  const doomed = hops;
  hops = [];
  if (doomed.some((h) => h.proc && h.proc.exitCode === null)) {
    log('[gui] Stopping wireproxy...');
  }
  for (const h of doomed) stopHop(h);
  stopHealthPolling();
  activeIds = [];
  chainId = null;
  setState('stopped');
}

function parseEndpoint(raw) {
  const m = (raw || '').trim().match(/^(.+):(\d+)$/);
  if (!m) return null;
  let host = m[1];
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, port: parseInt(m[2], 10) };
}

function findPeerEndpoint(text) {
  let inPeer = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const sec = /^\[([^\]]+)\]\s*$/.exec(t);
    if (sec) {
      inPeer = sec[1].toLowerCase() === 'peer';
      continue;
    }
    if (inPeer) {
      const m = /^Endpoint\s*=\s*(.+)$/i.exec(t);
      if (m) return parseEndpoint(m[1]);
    }
  }
  return null;
}

function parseSocksAddr(text) {
  let inSocks = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const sec = /^\[([^\]]+)\]\s*$/.exec(t);
    if (sec) {
      inSocks = sec[1].toLowerCase() === 'socks5';
      continue;
    }
    if (inSocks) {
      const m = /^BindAddress\s*=\s*([^\s#]+)/i.exec(t);
      if (m) return m[1];
    }
  }
  return null;
}

function parseSocksPort(text) {
  const addr = parseSocksAddr(text);
  if (addr) {
    const parsed = parseEndpoint(addr);
    if (parsed) return parsed.port;
  }
  return null;
}

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return String(n);
  if (v < 1024) return v + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let num = v;
  let i = -1;
  do {
    num /= 1024;
    i++;
  } while (num >= 1024 && i < units.length - 1);
  const str = num >= 100 ? num.toFixed(0) : num >= 10 ? num.toFixed(1) : num.toFixed(2);
  return str + ' ' + units[i];
}

function formatHandshake(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return 'never';
  const diff = Math.floor(Date.now() / 1000) - s;
  if (diff < 0) return 'just now';
  if (diff < 60) return diff + 's ago';
  const m = Math.floor(diff / 60);
  if (m < 60) return m + 'm ' + (diff % 60) + 's ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
}

// Turns the raw wg dump from /metrics (device block + one block per peer) into a
// compact summary. Kept: listen_port (device) and per-peer endpoint, tx, rx,
// last_handshake. toString() produces "set" format, so blocks are separated by
// blank lines; public_key is the first key of every peer block either way.
function summarizeMetrics(text) {
  const peers = [];
  const device = {};
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current) {
        peers.push(current);
        current = null;
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === 'public_key') {
      if (current) peers.push(current);
      current = { key: val };
      continue;
    }
    if (!current) {
      if (key === 'listen_port') device.listenPort = val;
      continue;
    }
    if (key === 'endpoint') current.endpoint = val;
    else if (key === 'tx_bytes') current.tx = val;
    else if (key === 'rx_bytes') current.rx = val;
    else if (key === 'last_handshake_time_sec') current.handshake = val;
  }
  if (current) peers.push(current);

  const out = [];
  if (device.listenPort) out.push('listen_port = ' + device.listenPort);
  const many = peers.length > 1;
  for (let i = 0; i < peers.length; i++) {
    const p = peers[i];
    const lines = [];
    if (p.endpoint) lines.push('endpoint = ' + p.endpoint);
    lines.push('last_handshake = ' + formatHandshake(p.handshake));
    lines.push('tx = ' + formatBytes(p.tx));
    lines.push('rx = ' + formatBytes(p.rx));
    if (lines.length === 0) continue;
    if (many) {
      out.push('Peer ' + (i + 1));
      for (const l of lines) out.push('  ' + l);
    } else {
      out.push(...lines);
    }
  }
  return out.join('\n');
}

// Counts [Peer] Endpoint lines. Hops past the first one must have exactly one:
// a second endpoint would be dialed directly, bypassing the chain.
function countPeerEndpoints(text) {
  let inPeer = false;
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const sec = /^\[([^\]]+)\]\s*$/.exec(t);
    if (sec) {
      inPeer = sec[1].toLowerCase() === 'peer';
      continue;
    }
    if (inPeer && /^Endpoint\s*=\s*.+$/i.test(t)) count++;
  }
  return count;
}

// Builds a chain-hop config: rewritten peer endpoint (when relayPort), deterministic
// Socks5 port (when socksPort; null preserves the original Socks5 section as-is).
// A chain-level bindAddress overrides the exit hop's [Socks5] BindAddress (injected
// when the section is missing). Inner hops keep only the sections a hop needs (extra
// routine sections are dropped to avoid port clashes); the exit hop (keepRoutines)
// keeps its full config — incl. [http]/tunnels/auth — so chaining preserves the
// user's exit setup.
function buildDerivedConf(text, opts) {
  const out = [];
  let currentSection = null;
  let skipSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sec = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (sec) {
      currentSection = sec[1].toLowerCase();
      skipSection = !opts.keepRoutines && SKIPPED_ROUTINE_SECTIONS.includes(currentSection);
      if (!skipSection) out.push(line);
      continue;
    }
    if (skipSection) continue;
    if (currentSection === 'peer') {
      const m = /^Endpoint\s*=\s*(.*)$/i.exec(trimmed);
      if (m && opts.relayPort) {
        out.push('Endpoint = 127.0.0.1:' + opts.relayPort);
        continue;
      }
      out.push(line);
      continue;
    }
    if (currentSection === 'socks5') {
      if (/^BindAddress\s*=/.test(trimmed)) {
        if (opts.socksPort != null) {
          out.push('BindAddress = 127.0.0.1:' + opts.socksPort);
        } else if (opts.bindAddress) {
          out.push('BindAddress = ' + opts.bindAddress);
        } else {
          out.push(line);
        }
        continue;
      }
      if (/^(Username|Password)\s*=/.test(trimmed) && opts.socksPort != null) {
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  if ((opts.socksPort != null || opts.bindAddress) && !out.some((l) => /^\[Socks5\]\s*$/i.test(l))) {
    out.push('');
    out.push('[Socks5]');
    out.push('BindAddress = ' + (opts.socksPort != null ? '127.0.0.1:' + opts.socksPort : opts.bindAddress));
  }
  return out.join('\n');
}

function launchHop(profile, opts) {
  const args = ['-c', opts.confPath, '-i', '127.0.0.1:' + opts.healthPort];
  if (opts.silent) args.push('-s');
  const proc = spawn(WIREPROXY_PATH, args, { windowsHide: true });
  const hop = {
    profileId: profile.id,
    name: profile.name,
    proc,
    healthPort: opts.healthPort,
    confPath: opts.confPath,
    socksPort: opts.socksPort || null,
    socksAddr: opts.socksAddr || null,
    derivedConfPath: opts.derivedConfPath || null,
    relay: null,
  };
  proc.stdout.on('data', (d) => { log(d.toString().replace(/\s+$/, '')); });
  proc.stderr.on('data', (d) => { log(d.toString().replace(/\s+$/, '')); });
  proc.on('error', (err) => {
    log('[gui] Failed to launch wireproxy: ' + err.message);
  });
  proc.on('exit', (code) => onHopExit(hop, code));
  hops.push(hop);
  log('[gui] hop "' + profile.name + '" started (PID ' + proc.pid + ', health port ' + opts.healthPort + ')');
  return hop;
}

async function startRelay(hop, prevHop, realEndpoint, relayPort) {
  const relay = new UdpOverSocksRelay({
    socksHost: '127.0.0.1',
    socksPort: prevHop.socksPort,
    target: { host: realEndpoint.host, port: realEndpoint.port },
    listenPort: relayPort,
    debugLog: (m) => log('[relay ' + hop.profileId + '] ' + m),
  });
  hop.relay = relay;
  await relay.start();
}

// items: [{ profileId, content }] in hop order (first = outermost).
async function startRun(items, opts) {
  const rendered = [];
  for (const it of items) {
    const profile = profiles.get(it.profileId);
    if (!profile) return { ok: false, output: 'Profile not found' };
    const content = it.content || profile.content;
    rendered.push({ profileId: it.profileId, name: profile.name, content });
  }
  const ids = rendered.map((r) => r.profileId);
  const token = ++runToken;
  const mine = [];

  // A superseded run must only touch its own hops, never a newer run's.
  const abortIfSuperseded = () => {
    if (token === runToken) return false;
    for (const h of mine) {
      const idx = hops.indexOf(h);
      if (idx !== -1) hops.splice(idx, 1);
      stopHop(h);
    }
    return true;
  };
  const assertMineAlive = () => {
    for (const h of mine) {
      if (!h.proc || h.proc.exitCode !== null) {
        throw new Error('Hop "' + h.name + '" exited during startup (code ' + (h.proc ? h.proc.exitCode : 'n/a') + ')');
      }
    }
  };

  if (hops.length > 0) {
    const same =
      activeIds.length === ids.length &&
      activeIds.every((id, i) => id === ids[i]);
    if (same) return { ok: false, output: 'Already running' };
    log('[gui] Stopping current connection to switch...');
    await stopCurrent();
    if (abortIfSuperseded()) {
      return { ok: false, output: 'Superseded by a newer connection' };
    }
  }

  chainId = opts.chainId || null;
  activeIds = ids.slice();
  setState('validating');

  try {
    for (let i = 0; i < rendered.length; i++) {
      const r = rendered[i];
      const profile = profiles.get(r.profileId);
      const originalConfPath = profiles.confPath(r.profileId);
      const test = await runConfigTest(originalConfPath);
      if (abortIfSuperseded()) {
        return { ok: false, output: 'Superseded by a newer connection' };
      }
      assertMineAlive();
      if (test.code !== 0) {
        throw new Error(
          'Config error in "' + r.name + '": ' + (test.stderr || test.stdout || ('code ' + test.code))
        );
      }

      const isLast = i === rendered.length - 1;
      let confPath = originalConfPath;
      let derivedConfPath = null;
      let socksPort = null;
      let relayPort = null;
      let realEndpoint = null;

      // Every hop except the first routes its WG transport through the previous hop.
      // Every hop except the last exposes a deterministic Socks5 port for the next relay.
      // A chain-level bindAddress forces the exit hop through a derived config too.
      const needsRewrite = i > 0 || !isLast;
      const overrideBind = isLast && opts.bindAddress;

      if (needsRewrite || overrideBind) {
        if (i > 0) {
          const epCount = countPeerEndpoints(r.content);
          if (epCount === 0) {
            throw new Error(
              'Profile "' + r.name + '" has no [Peer] Endpoint; cannot be used as a chain hop'
            );
          }
          if (epCount > 1) {
            throw new Error(
              'Profile "' + r.name + '" has ' + epCount + ' [Peer] endpoints; chain hops support exactly one (extra endpoints would bypass the chain)'
            );
          }
          realEndpoint = findPeerEndpoint(r.content);
          relayPort = await getFreePort();
          if (abortIfSuperseded()) {
            return { ok: false, output: 'Superseded by a newer connection' };
          }
          assertMineAlive();
        }
        socksPort = isLast ? null : await getFreePort();
        const derived = buildDerivedConf(r.content, {
          socksPort,
          relayPort,
          keepRoutines: isLast,
          bindAddress: overrideBind ? opts.bindAddress : null,
        });
        derivedConfPath = path.join(runDir, crypto.randomUUID() + '.conf');
        fs.writeFileSync(derivedConfPath, derived, 'utf8');
        const t2 = await runConfigTest(derivedConfPath);
        if (abortIfSuperseded()) {
          removeFile(derivedConfPath);
          return { ok: false, output: 'Superseded by a newer connection' };
        }
        assertMineAlive();
        if (t2.code !== 0) {
          throw new Error(
            'Derived config invalid for "' + r.name + '": ' + (t2.stderr || t2.stdout || ('code ' + t2.code))
          );
        }
        confPath = derivedConfPath;
      }

      const hop = launchHop(profile, {
        confPath,
        healthPort: await getFreePort(),
        silent: opts.silent,
        socksPort,
        socksAddr: socksPort != null ? '127.0.0.1:' + socksPort : overrideBind ? opts.bindAddress : null,
        derivedConfPath,
      });
      mine.push(hop);
      if (abortIfSuperseded()) {
        return { ok: false, output: 'Superseded by a newer connection' };
      }
      assertMineAlive();

      if (relayPort !== null && realEndpoint) {
        await startRelay(hop, hops[i - 1], realEndpoint, relayPort);
        if (abortIfSuperseded()) {
          return { ok: false, output: 'Superseded by a newer connection' };
        }
        assertMineAlive();
      }
    }
  } catch (e) {
    const exits = [];
    for (const h of mine) {
      const idx = hops.indexOf(h);
      if (idx !== -1) hops.splice(idx, 1);
      if (h.proc && h.proc.exitCode === null) {
        exits.push(new Promise((resolve) => h.proc.once('exit', resolve)));
      }
      stopHop(h);
    }
    await Promise.all(exits);
    stopHealthPolling();
    if (token === runToken) setState('error');
    return { ok: false, output: e.message };
  }

  setState('connecting');
  startHealthPolling();
  log('[gui] connection started: ' + ids.join(' -> '));
  return { ok: true };
}

async function startVpn(id, text, silent) {
  const profile = profiles.get(id);
  if (!profile) return { ok: false, output: 'Profile not found' };
  const content = text || profile.content;
  try {
    profiles.save(id, content);
  } catch (e) {
    return { ok: false, output: 'Failed to save config: ' + e.message };
  }
  return startRun([{ profileId: id, content }], { silent, chainId: null });
}

async function startChain(chainId, silent) {
  const chain = chains.get(chainId);
  if (!chain) return { ok: false, output: 'Chain not found' };
  if (chain.profileIds.length === 0) {
    return { ok: false, output: 'Chain "' + chain.name + '" has no profiles' };
  }
  const items = [];
  for (const id of chain.profileIds) {
    const profile = profiles.get(id);
    if (!profile) return { ok: false, output: 'Chain references a missing profile' };
    items.push({ profileId: id, content: profile.content });
  }
  return startRun(items, { silent, chainId: chain.id, bindAddress: chain.bindAddress || null });
}

function autostartEnabled() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) return app.getLoginItemSettings({ path: portable }).openAtLogin;
  return app.getLoginItemSettings().openAtLogin;
}

function applyAutostart(enabled) {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) {
    app.setLoginItemSettings({ openAtLogin: enabled, path: portable });
    return;
  }
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [app.getAppPath()] });
}

function defaultTarget() {
  const s = settings.get();
  if (s.defaultTarget && s.defaultTarget.id) {
    return { kind: s.defaultTarget.kind, id: s.defaultTarget.id };
  }
  if (s.defaultProfileId) {
    return { kind: 'profile', id: s.defaultProfileId };
  }
  return null;
}

function targetExists(kind, id) {
  if (kind === 'chain') return !!chains.get(id);
  return !!profiles.get(id);
}

function targetName(kind, id) {
  if (!id) return null;
  if (kind === 'chain') {
    const c = chains.get(id);
    return c ? c.name : null;
  }
  const p = profiles.get(id);
  return p ? p.name : null;
}

function trayState() {
  const target = defaultTarget();
  return {
    stateLabel: STATE_LABEL[state] || state,
    windowVisible: !!(mainWindow && mainWindow.isVisible()),
    running: hops.some((h) => h.proc && h.proc.exitCode === null),
    autostart: autostartEnabled(),
    autoconnect: !!settings.get().autoconnect,
    defaultTargetName: target ? targetName(target.kind, target.id) : null,
    hasDefaultTarget: !!(target && targetName(target.kind, target.id)),
  };
}

function maybeAutoConnect() {
  const s = settings.get();
  if (!s.autoconnect) return;
  const target = defaultTarget();
  if (!target || !targetExists(target.kind, target.id)) {
    log('[gui] Auto-connect skipped: default target is missing');
    return;
  }
  if (hops.some((h) => h.proc && h.proc.exitCode === null)) {
    log('[gui] Auto-connect skipped: connection already running');
    return;
  }
  const name = targetName(target.kind, target.id);
  log('[gui] Auto-connecting "' + name + '"...');
  if (target.kind === 'chain') {
    startChain(target.id, false);
  } else {
    const profile = profiles.get(target.id);
    startVpn(profile.id, profile.content, false);
  }
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    for (const h of hops) stopHop(h);
  });

  app.on('will-quit', () => {
    if (trayCtrl) {
      trayCtrl.destroy();
      trayCtrl = null;
    }
  });

  app.on('window-all-closed', () => {
    // keep running in the tray; quit only via the tray menu
  });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    profiles.init(userData);
    settings.init(userData);
    chains.init(userData);
    runDir = path.join(userData, DERIVED_CONF_DIRNAME);
    fs.mkdirSync(runDir, { recursive: true });
    try {
      for (const f of fs.readdirSync(runDir)) removeFile(path.join(runDir, f));
    } catch {}

    trayCtrl = new TrayController({
      iconPath: path.join(__dirname, 'icon.png'),
      getState: trayState,
      onToggleWindow: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      },
      onStartStop: () => {
        if (hops.some((h) => h.proc && h.proc.exitCode === null)) {
          stopVpn();
          return;
        }
        const target = defaultTarget();
        if (!target || !targetExists(target.kind, target.id)) return;
        if (target.kind === 'chain') {
          startChain(target.id, false);
        } else {
          const profile = profiles.get(target.id);
          startVpn(profile.id, profile.content, false);
        }
      },
      onSetAutostart: (enabled) => {
        try {
          applyAutostart(!!enabled);
          settings.save({ autostart: !!enabled });
        } catch (e) {
          log('[gui] Autostart failed: ' + e.message);
        }
        syncTray();
      },
      onSetAutoconnect: (enabled) => {
        if (enabled && !defaultTarget()) return;
        settings.save({ autoconnect: !!enabled });
        syncTray();
      },
      onQuit: () => {
        app.quit();
      },
    });

    mainWindow = new BrowserWindow({
      width: 1100,
      height: 760,
      title: 'wireproxy-awg GUI',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      mainWindow.hide();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.on('did-finish-load', () => maybeAutoConnect());
  });
}

ipcMain.handle('profiles:list', () => {
  try {
    return { ok: true, profiles: profiles.list() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('profiles:get', (_e, id) => {
  const profile = profiles.get(id);
  return profile ? { ok: true, profile } : { ok: false, error: 'Profile not found' };
});

ipcMain.handle('profiles:create', () => {
  try {
    return { ok: true, profile: profiles.create() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('profiles:save', (_e, id, text) => {
  try {
    profiles.save(id, text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('profiles:validate', async (_e, id, text) => {
  try {
    profiles.save(id, text);
  } catch (e) {
    return { ok: false, output: 'Failed to save config: ' + e.message };
  }
  const test = await runConfigTest(profiles.confPath(id));
  if (test.code === 0) {
    return { ok: true, output: test.stdout || 'Config OK' };
  }
  return { ok: false, output: test.stderr || test.stdout || 'Config error (code ' + test.code + ')' };
});

ipcMain.handle('profiles:rename', (_e, id, name) => {
  try {
    profiles.rename(id, name);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('profiles:delete', async (_e, id) => {
  try {
    if (activeIds.includes(id) && hops.some((h) => h.proc && h.proc.exitCode === null)) {
      log('[gui] Stopping connection before delete...');
      runToken++;
      await stopCurrent();
    }
    profiles.remove(id);
    chains.pruneDeletedProfiles(profiles.list().map((p) => p.id));
    const target = defaultTarget();
    if (target && target.id === id) {
      settings.save({ defaultTarget: null, autoconnect: false });
      syncTray();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('vpn:start', (_e, opts) => {
  const silent = !!(opts && opts.silent);
  if (opts && opts.chainId) {
    return startChain(opts.chainId, silent);
  }
  const text = (opts && opts.text) || '';
  const id = opts && opts.id;
  if (!id) return { ok: false, output: 'Nothing to start' };
  return startVpn(id, text, silent);
});

ipcMain.handle('vpn:stop', () => {
  stopVpn();
  return { ok: true };
});

ipcMain.handle('vpn:state', () => {
  return {
    state,
    running: hops.some((h) => h.proc && h.proc.exitCode === null),
    activeProfileId: activeIds[activeIds.length - 1] || null,
    activeIds,
    chainId,
  };
});

ipcMain.handle('chains:list', () => {
  try {
    const all = chains.list();
    return { ok: true, chains: all, profiles: profiles.list() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('chains:get', (_e, id) => {
  const chain = chains.get(id);
  return chain ? { ok: true, chain, profiles: profiles.list() } : { ok: false, error: 'Chain not found' };
});

ipcMain.handle('chains:create', () => {
  try {
    const chain = chains.create();
    return { ok: true, chain };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('chains:save', (_e, id, name, profileIds, bindAddress) => {
  try {
    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      throw new Error('A chain needs at least one profile');
    }
    for (const pid of profileIds) {
      const p = profiles.get(pid);
      if (!p) throw new Error('Chain references a missing profile');
      if (countPeerEndpoints(p.content) > 1) {
        throw new Error('Profile "' + p.name + '" has multiple [Peer] endpoints; chain hops support exactly one (extra endpoints would bypass the chain)');
      }
    }
    const ba = (bindAddress || '').trim();
    if (ba && (!parseEndpoint(ba) || !parseEndpoint(ba).host)) {
      throw new Error('BindAddress must be empty or "host:port" (e.g. 127.0.0.1:25344)');
    }
    chains.save(id, name, profileIds, ba);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('chains:rename', (_e, id, name) => {
  try {
    chains.rename(id, name);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('chains:delete', (_e, id) => {
  try {
    if (chainId === id && hops.some((h) => h.proc && h.proc.exitCode === null)) {
      stopVpn();
    }
    chains.remove(id);
    const target = defaultTarget();
    if (target && target.kind === 'chain' && target.id === id) {
      settings.save({ defaultTarget: null, autoconnect: false });
      syncTray();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('settings:get', () => {
  const s = settings.get();
  const target = defaultTarget();
  return {
    ok: true,
    autostart: autostartEnabled(),
    autoconnect: !!s.autoconnect,
    defaultTarget: target,
    profiles: profiles.list(),
    chains: chains.list(),
  };
});

ipcMain.handle('settings:setAutostart', (_e, enabled) => {
  try {
    applyAutostart(!!enabled);
    settings.save({ autostart: !!enabled });
    syncTray();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('settings:setAutoconnect', (_e, enabled) => {
  const on = !!enabled;
  if (on && !defaultTarget()) {
    return { ok: false, error: 'Set a default target first' };
  }
  settings.save({ autoconnect: on });
  syncTray();
  return { ok: true };
});

ipcMain.handle('settings:setDefaultTarget', (_e, kind, id) => {
  const cleanKind = kind === 'chain' ? 'chain' : 'profile';
  if (id) {
    if (!targetExists(cleanKind, id)) {
      return { ok: false, error: 'Target not found' };
    }
  }
  settings.save({ defaultTarget: id ? { kind: cleanKind, id } : null, autoconnect: id ? settings.get().autoconnect : false });
  syncTray();
  return { ok: true };
});