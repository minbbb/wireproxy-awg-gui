'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const VpnEngine = require('../core/vpn-engine');
const profiles = require('../core/profiles');
const chains = require('../core/chains');

const BIN = path.join(__dirname, '..', 'bin', 'wireproxy.exe');
const HAS_BIN = fs.existsSync(BIN);

class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.killed = false;
  }
  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0);
  }
}

function makeEngine() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-engine-'));
  const engine = new VpnEngine({
    wireproxyPath: 'n/a',
    runDir,
    profiles: { get: () => null },
    chains: { get: () => null },
  });
  engine.on('log', () => {});
  return { engine, runDir };
}

function fakeHop(id, name, proc) {
  return {
    profileId: id,
    name,
    proc,
    healthPort: 1,
    confPath: 'x',
    socksPort: null,
    socksAddr: null,
    derivedConfPath: null,
    relay: null,
  };
}

test('currentRun snapshot and hasRunningHop ignores spawnError hops', () => {
  const { engine } = makeEngine();
  assert.deepStrictEqual(engine.currentRun(), {
    state: 'stopped',
    running: false,
    activeProfileId: null,
    activeIds: [],
    chainId: null,
  });
  const hop = fakeHop('p1', 'a', new FakeProc());
  engine.hops.push(hop);
  assert.strictEqual(engine.hasRunningHop(), true);
  hop.spawnError = new Error('boom');
  assert.strictEqual(engine.hasRunningHop(), false);
});

test('stop() kills hops and resets run state', () => {
  const { engine } = makeEngine();
  engine.state = 'connected';
  engine.activeIds = ['p1'];
  engine.chainId = 'c1';
  const proc = new FakeProc();
  engine.hops.push(fakeHop('p1', 'a', proc));
  engine.stop();
  assert.strictEqual(proc.killed, true);
  assert.strictEqual(engine.state, 'stopped');
  assert.deepStrictEqual(engine.activeIds, []);
  assert.strictEqual(engine.chainId, null);
  assert.strictEqual(engine.hops.length, 0);
});

test('stopIfActive is a no-op when the connection is not running', async () => {
  const { engine } = makeEngine();
  engine.activeIds = ['p1'];
  const proc = new FakeProc();
  engine.hops.push(fakeHop('p1', 'a', proc));
  proc.exitCode = 3; // dead already
  await engine.stopIfActive(['p1']);
  assert.strictEqual(proc.killed, false);
});

test('stopIfActive stops a live connection containing one of the ids', async () => {
  const { engine } = makeEngine();
  engine.activeIds = ['p1'];
  const proc = new FakeProc();
  engine.hops.push(fakeHop('p1', 'a', proc));
  await engine.stopIfActive(['p1']);
  assert.strictEqual(proc.killed, true);
  assert.strictEqual(engine.hops.length, 0);
});

test('stopChainIfActive stops only the currently running chain', () => {
  const { engine } = makeEngine();
  engine.state = 'connected';
  engine.chainId = 'c1';
  const proc = new FakeProc();
  engine.hops.push(fakeHop('p1', 'a', proc));

  engine.stopChainIfActive('c2');
  assert.strictEqual(proc.killed, false);

  engine.stopChainIfActive('c1');
  assert.strictEqual(proc.killed, true);
  assert.strictEqual(engine.state, 'stopped');
});

test('steady-state hop exit kills the whole run', () => {
  const { engine } = makeEngine();
  engine.state = 'connected';
  engine.activeIds = ['p1', 'p2'];
  engine.chainId = 'c1';
  const p1 = new FakeProc();
  const p2 = new FakeProc();
  engine.hops = [fakeHop('p1', 'a', p1), fakeHop('p2', 'b', p2)];
  engine._onHopExit(engine.hops[0], 1);
  assert.strictEqual(p1.killed, true);
  assert.strictEqual(p2.killed, true);
  assert.strictEqual(engine.state, 'stopped');
  assert.deepStrictEqual(engine.activeIds, []);
  assert.strictEqual(engine.chainId, null);
  assert.strictEqual(engine.hops.length, 0);
});

test('spawnError hop exit is treated like a steady-state death', () => {
  const { engine } = makeEngine();
  engine.state = 'connected';
  const proc = new FakeProc();
  const hop = fakeHop('p1', 'a', proc);
  hop.spawnError = new Error('ENOENT');
  engine.hops = [hop];
  engine._onHopExit(hop, null);
  assert.strictEqual(engine.state, 'stopped');
  assert.strictEqual(engine.hops.length, 0);
});

test('exit during validating only splices the hop; startRun loop decides', () => {
  const { engine } = makeEngine();
  engine.state = 'validating';
  const proc = new FakeProc();
  const hop = fakeHop('p1', 'a', proc);
  engine.hops = [hop];
  engine._onHopExit(hop, 1);
  assert.strictEqual(engine.hops.length, 0);
  assert.strictEqual(engine.state, 'validating');
});

function placeholderConf(endpoint) {
  const k1 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
  const k2 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 33)).toString('base64');
  return [
    '[Interface]',
    'PrivateKey = ' + k1,
    'Address = 10.0.0.2/32',
    '',
    '[Peer]',
    'PublicKey = ' + k2,
    'Endpoint = ' + endpoint,
    'AllowedIPs = 0.0.0.0/0',
    '',
  ].join('\n');
}

function waitFor(fn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = fn();
      if (value) return resolve(value);
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for ' + label));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function makeEngineRun(tmp) {
  profiles.init(tmp);
  chains.init(tmp);
  const runDir = path.join(tmp, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const engine = new VpnEngine({ wireproxyPath: BIN, runDir, profiles, chains });
  engine.on('log', () => {});
  return engine;
}

test('startVpn reaches connected and stop returns to stopped (integration)', { skip: !HAS_BIN && 'wireproxy.exe not present' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-int-'));
  const engine = await makeEngineRun(tmp);
  try {
    const profile = profiles.create();
    const res = await engine.startVpn(profile.id, placeholderConf('1.2.3.4:51820'), true);
    assert.strictEqual(res.ok, true);
    await waitFor(() => engine.state === 'connected', 10000, 'connected state');
    engine.stop();
    assert.strictEqual(engine.state, 'stopped');
    assert.strictEqual(engine.hops.length, 0);
  } finally {
    engine.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('startChain connects all hops (integration)', { skip: !HAS_BIN && 'wireproxy.exe not present' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-int-'));
  const engine = await makeEngineRun(tmp);
  try {
    const p1 = profiles.create();
    profiles.save(p1.id, placeholderConf('1.2.3.4:51820'));
    const p2 = profiles.create();
    profiles.save(p2.id, placeholderConf('5.6.7.8:51821'));
    const chain = chains.create();
    chains.save(chain.id, 'Test chain', [p1.id, p2.id], '');
    const res = await engine.startChain(chain.id, true);
    assert.strictEqual(res.ok, true);
    await waitFor(() => engine.state === 'connected', 15000, 'chain connected state');
    assert.strictEqual(engine.hops.length, 2);
    engine.stop();
    assert.strictEqual(engine.state, 'stopped');
    assert.strictEqual(engine.hops.length, 0);
  } finally {
    engine.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});