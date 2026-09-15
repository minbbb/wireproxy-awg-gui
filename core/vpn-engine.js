// VpnEngine — pure Node orchestration of wireproxy child processes (single run
// or a chain of hops). No Electron imports. External effects are emitted as
// events: 'log', 'status', 'readyz', 'metrics'. The Electron main process wires
// those events to the renderer and tray.
//
// Dependencies are injected: wireproxyPath, runDir and the profiles/chains
// persistence modules. State machine:
//   stopped → validating → connecting → connected|degraded → (error|stopped)
//
// Concurrency: runToken is bumped by any operation that invalidates the current
// run (new start, stop, unexpected hop exit, profile delete). The startup loop
// aborts when its captured token no longer matches, so a superseded startRun
// never touches a newer run's hops.

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UdpOverSocksRelay } = require('../relay');
const { parseSocksAddr, parseSocksPort, findPeerEndpoint, countPeerEndpoints } = require('./config-parser');
const { summarizeMetrics } = require('./metrics');
const { buildDerivedConf } = require('./derived-config');
const { getFreePort, removeFile, createConfigTester, httpGet } = require('./process-utils');

class VpnEngine extends EventEmitter {
  constructor(opts) {
    super();
    this.wireproxyPath = opts.wireproxyPath;
    this.runDir = opts.runDir;
    this.profiles = opts.profiles;
    this.chains = opts.chains;
    this.configTester = createConfigTester(this.wireproxyPath);

    // hops[] — ordered list of running wireproxy instances. Each hop:
    // { profileId, name, proc, healthPort, confPath, socksPort|null, socksAddr|null, derivedConfPath|null, relay|null }
    this.hops = [];
    this.state = 'stopped';
    this.activeIds = [];
    this.chainId = null;
    this.healthTimer = null;
    this.runToken = 0;
  }

  get stateValue() {
    return this.state;
  }

  get activeProfileId() {
    return this.activeIds[this.activeIds.length - 1] || null;
  }

  hasRunningHop() {
    return this.hops.some((h) => h.proc && h.proc.exitCode === null);
  }

  _log(line) {
    this.emit('log', line);
  }

  _setState(newState) {
    this.state = newState;
    this.emit('status', {
      state: newState,
      activeProfileId: this.activeIds[this.activeIds.length - 1] || null,
      activeIds: this.activeIds,
      chainId: this.chainId,
    });
  }

  _startHealthPolling() {
    this._stopHealthPolling();
    this.healthTimer = setInterval(() => this._pollHealth(), 1000);
  }

  _stopHealthPolling() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  async _pollHealth() {
    if (this.hops.length === 0) return;
    const report = [];
    let alive = false;
    let unreachable = false;
    let degraded = false;
    for (const h of this.hops) {
      if (!h.proc || h.proc.exitCode !== null) continue;
      alive = true;
      const readyz = await httpGet('/readyz', h.healthPort);
      if (!h.proc || h.proc.exitCode !== null) return;
      report.push({
        profileId: h.profileId,
        name: h.name,
        status: readyz.status || readyz.error,
        body: readyz.body || '',
        socksPort: h.socksPort || (h === this.hops[this.hops.length - 1] ? parseSocksPort(this.profiles.get(h.profileId)?.content || '') : null),
        socksAddr: h.socksAddr || (h === this.hops[this.hops.length - 1] ? parseSocksAddr(this.profiles.get(h.profileId)?.content || '') : null),
      });
      if (readyz.error) unreachable = true;
      else if (readyz.status === 503) degraded = true;
    }
    if (!alive) return;
    if (unreachable) this._setState('connecting');
    else if (degraded) this._setState('degraded');
    else this._setState('connected');
    this.emit('readyz', { hops: report });
    const exit = this.hops[this.hops.length - 1];
    if (exit && exit.proc && exit.proc.exitCode === null) {
      const metrics = await httpGet('/metrics', exit.healthPort);
      if (!exit.proc || exit.proc.exitCode !== null) return;
      if (!metrics.error && metrics.status === 200) {
        this.emit('metrics', { text: summarizeMetrics(metrics.body) });
      }
    }
  }

  _stopHop(h) {
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

  _onHopExit(hop, code) {
    this._log('[gui] hop "' + hop.name + '" exited (code ' + code + ')');
    if (hop.relay) {
      try { hop.relay.stop(); } catch {}
      hop.relay = null;
    }
    const idx = this.hops.indexOf(hop);
    if (idx === -1) return;
    if (this.state === 'validating') {
      // Startup still in progress: let the startRun loop raise the real error
      // via its liveness checks, so the user sees the cause, not a generic stop.
      this.hops.splice(idx, 1);
      return;
    }
    // Steady state: a chain is only valid as a whole, so one dead hop kills the run.
    this.runToken++;
    const rest = this.hops;
    this.hops = [];
    for (const h of rest) this._stopHop(h);
    this._stopHealthPolling();
    this.activeIds = [];
    this.chainId = null;
    this._setState('stopped');
  }

  async _stopCurrent() {
    const old = this.hops;
    this.hops = [];
    const exits = old.map((h) => {
      if (h.proc && h.proc.exitCode === null) {
        return new Promise((resolve) => h.proc.once('exit', resolve));
      }
      return Promise.resolve();
    });
    for (const h of old) this._stopHop(h);
    await Promise.all(exits);
    this._stopHealthPolling();
  }

  stop() {
    this.runToken++;
    const doomed = this.hops;
    this.hops = [];
    if (doomed.some((h) => h.proc && h.proc.exitCode === null)) {
      this._log('[gui] Stopping wireproxy...');
    }
    for (const h of doomed) this._stopHop(h);
    this._stopHealthPolling();
    this.activeIds = [];
    this.chainId = null;
    this._setState('stopped');
  }

  // Kills hops without touching run state. Used on app quit (before-quit).
  shutdown() {
    for (const h of this.hops) this._stopHop(h);
  }

  // Stops the current run if any of the given profile ids is part of it and at
  // least one hop is alive (profile-delete path). Does not reset state.
  async stopIfActive(ids) {
    const active = new Set(this.activeIds);
    if (ids.some((id) => active.has(id)) && this.hasRunningHop()) {
      this._log('[gui] Stopping connection before delete...');
      this.runToken++;
      await this._stopCurrent();
    }
  }

  // Stops the whole run if the given chain is the running one (chain-delete path).
  stopChainIfActive(chainId) {
    if (this.chainId === chainId && this.hasRunningHop()) {
      this.stop();
    }
  }

  _launchHop(profile, opts) {
    const args = ['-c', opts.confPath, '-i', '127.0.0.1:' + opts.healthPort];
    if (opts.silent) args.push('-s');
    const proc = spawn(this.wireproxyPath, args, { windowsHide: true });
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
    proc.stdout.on('data', (d) => { this._log(d.toString().replace(/\s+$/, '')); });
    proc.stderr.on('data', (d) => { this._log(d.toString().replace(/\s+$/, '')); });
    proc.on('error', (err) => {
      this._log('[gui] Failed to launch wireproxy: ' + err.message);
    });
    proc.on('exit', (code) => this._onHopExit(hop, code));
    this.hops.push(hop);
    this._log('[gui] hop "' + profile.name + '" started (PID ' + proc.pid + ', health port ' + opts.healthPort + ')');
    return hop;
  }

  async _startRelay(hop, prevHop, realEndpoint, relayPort) {
    const relay = new UdpOverSocksRelay({
      socksHost: '127.0.0.1',
      socksPort: prevHop.socksPort,
      target: { host: realEndpoint.host, port: realEndpoint.port },
      listenPort: relayPort,
      debugLog: (m) => this._log('[relay ' + hop.profileId + '] ' + m),
    });
    hop.relay = relay;
    await relay.start();
  }

  // items: [{ profileId, content }] in hop order (first = outermost).
  async _startRun(items, opts) {
    const rendered = [];
    for (const it of items) {
      const profile = this.profiles.get(it.profileId);
      if (!profile) return { ok: false, output: 'Profile not found' };
      const content = it.content || profile.content;
      rendered.push({ profileId: it.profileId, name: profile.name, content });
    }
    const ids = rendered.map((r) => r.profileId);
    const token = ++this.runToken;
    const mine = [];

    // A superseded run must only touch its own hops, never a newer run's.
    const abortIfSuperseded = () => {
      if (token === this.runToken) return false;
      for (const h of mine) {
        const idx = this.hops.indexOf(h);
        if (idx !== -1) this.hops.splice(idx, 1);
        this._stopHop(h);
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

    if (this.hops.length > 0) {
      const same =
        this.activeIds.length === ids.length &&
        this.activeIds.every((id, i) => id === ids[i]);
      if (same) return { ok: false, output: 'Already running' };
      this._log('[gui] Stopping current connection to switch...');
      await this._stopCurrent();
      if (abortIfSuperseded()) {
        return { ok: false, output: 'Superseded by a newer connection' };
      }
    }

    this.chainId = opts.chainId || null;
    this.activeIds = ids.slice();
    this._setState('validating');

    try {
      for (let i = 0; i < rendered.length; i++) {
        const r = rendered[i];
        const profile = this.profiles.get(r.profileId);
        const originalConfPath = this.profiles.confPath(r.profileId);
        const test = await this.configTester(originalConfPath);
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
          derivedConfPath = path.join(this.runDir, crypto.randomUUID() + '.conf');
          fs.writeFileSync(derivedConfPath, derived, 'utf8');
          const t2 = await this.configTester(derivedConfPath);
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

        const hop = this._launchHop(profile, {
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
          await this._startRelay(hop, this.hops[i - 1], realEndpoint, relayPort);
          if (abortIfSuperseded()) {
            return { ok: false, output: 'Superseded by a newer connection' };
          }
          assertMineAlive();
        }
      }
    } catch (e) {
      const exits = [];
      for (const h of mine) {
        const idx = this.hops.indexOf(h);
        if (idx !== -1) this.hops.splice(idx, 1);
        if (h.proc && h.proc.exitCode === null) {
          exits.push(new Promise((resolve) => h.proc.once('exit', resolve)));
        }
        this._stopHop(h);
      }
      await Promise.all(exits);
      this._stopHealthPolling();
      if (token === this.runToken) this._setState('error');
      return { ok: false, output: e.message };
    }

    this._setState('connecting');
    this._startHealthPolling();
    this._log('[gui] connection started: ' + ids.join(' -> '));
    return { ok: true };
  }

  async startVpn(id, text, silent) {
    const profile = this.profiles.get(id);
    if (!profile) return { ok: false, output: 'Profile not found' };
    const content = text || profile.content;
    try {
      this.profiles.save(id, content);
    } catch (e) {
      return { ok: false, output: 'Failed to save config: ' + e.message };
    }
    return this._startRun([{ profileId: id, content }], { silent, chainId: null });
  }

  async startChain(chainId, silent) {
    const chain = this.chains.get(chainId);
    if (!chain) return { ok: false, output: 'Chain not found' };
    if (chain.profileIds.length === 0) {
      return { ok: false, output: 'Chain "' + chain.name + '" has no profiles' };
    }
    const items = [];
    for (const id of chain.profileIds) {
      const profile = this.profiles.get(id);
      if (!profile) return { ok: false, output: 'Chain references a missing profile' };
      items.push({ profileId: id, content: profile.content });
    }
    return this._startRun(items, { silent, chainId: chain.id, bindAddress: chain.bindAddress || null });
  }

  // Returns the current run snapshot for the renderer (vpn:state).
  currentRun() {
    return {
      state: this.state,
      running: this.hasRunningHop(),
      activeProfileId: this.activeProfileId,
      activeIds: this.activeIds,
      chainId: this.chainId,
    };
  }
}

module.exports = VpnEngine;