const { test } = require('node:test');
const assert = require('node:assert');
const { createTargetService } = require('../services/targets');
const { createSettingsActions } = require('../services/settings-actions');

const app = {
  isPackaged: true,
  setLoginItemSettings() {},
  getLoginItemSettings() { return { openAtLogin: false }; },
};

function makeEnv() {
  let store = { autostart: false, autoconnect: false, defaultTarget: null, defaultProfileId: null };
  const settings = {
    get: () => ({ ...store }),
    save: (patch) => { Object.assign(store, patch); return store; },
  };
  const profiles = {
    get: (id) => (id === 'p1' ? { id: 'p1', name: 'P1', content: '' } : null),
  };
  const chains = {
    get: (id) => (id === 'c1' ? { id: 'c1', name: 'C1', profileIds: ['p1'] } : null),
  };
  const targets = createTargetService({ settings, profiles, chains });
  let syncCount = 0;
  const actions = createSettingsActions({
    app,
    settings,
    targets,
    autostart: { autostartEnabled: () => store.autostart, applyAutostart: () => {} },
    onSync: () => { syncCount++; },
  });
  return { store, settings, targets, actions, syncCount: () => syncCount };
}

test('defaultTarget falls back to legacy defaultProfileId', () => {
  const env = makeEnv();
  env.store.defaultProfileId = 'p1';
  assert.deepStrictEqual(env.targets.defaultTarget(), { kind: 'profile', id: 'p1' });
});

test('setAutoconnect requires a default target', () => {
  const env = makeEnv();
  const res = env.actions.setAutoconnect(true);
  assert.deepStrictEqual(res, { ok: false, error: 'Set a default target first' });
  assert.strictEqual(env.store.autoconnect, false);
});

test('setAutoconnect after setting target', () => {
  const env = makeEnv();
  env.actions.setDefaultTarget('profile', 'p1');
  const res = env.actions.setAutoconnect(true);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(env.store.autoconnect, true);
});

test('setDefaultTarget rejects unknown targets', () => {
  const env = makeEnv();
  const res = env.actions.setDefaultTarget('profile', 'nope');
  assert.deepStrictEqual(res, { ok: false, error: 'Target not found' });
});

test('clearing default target disables autoconnect', () => {
  const env = makeEnv();
  env.actions.setDefaultTarget('chain', 'c1');
  env.actions.setAutoconnect(true);
  env.actions.setDefaultTarget('chain', null);
  assert.strictEqual(env.store.defaultTarget, null);
  assert.strictEqual(env.store.autoconnect, false);
});

test('clearTargetIf matches a deleted profile id', () => {
  const env = makeEnv();
  env.actions.setDefaultTarget('profile', 'p1');
  const cleared = env.actions.clearTargetIf((t) => t.id === 'p1');
  assert.strictEqual(cleared, true);
  assert.strictEqual(env.store.defaultTarget, null);
  assert.strictEqual(env.store.autoconnect, false);
});

test('setAutostart persists and syncs', () => {
  const env = makeEnv();
  env.actions.setAutostart(true);
  assert.strictEqual(env.store.autostart, true);
  assert.strictEqual(env.syncCount(), 1);
});