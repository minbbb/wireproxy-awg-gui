// Thin IPC wiring: registers all ipcMain.handle channels. No business logic —
// delegates to the injected core/services. Returns { ok: true, ... } or
// { ok: false, error/output } exactly as before the refactor.

const { parseEndpoint, countPeerEndpoints } = require('../core/config-parser');

function registerIpc({ ipcMain, app, engine, profiles, chains, settings, targets, autostart, actions }) {
  ipcMain.handle('app:info', () => ({ ok: true, version: app.getVersion() }));

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
    const test = await engine.configTester(profiles.confPath(id));
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
      await engine.stopIfActive([id]);
      profiles.remove(id);
      chains.pruneDeletedProfiles(profiles.list().map((p) => p.id));
      actions.clearTargetIf((target) => target.id === id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('vpn:start', (_e, opts) => {
    const silent = !!(opts && opts.silent);
    if (opts && opts.chainId) {
      return engine.startChain(opts.chainId, silent);
    }
    const text = (opts && opts.text) || '';
    const id = opts && opts.id;
    if (!id) return { ok: false, output: 'Nothing to start' };
    return engine.startVpn(id, text, silent);
  });

  ipcMain.handle('vpn:stop', () => {
    engine.stop();
    return { ok: true };
  });

  ipcMain.handle('vpn:state', () => {
    return engine.currentRun();
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
      engine.stopChainIfActive(id);
      chains.remove(id);
      actions.clearTargetIf((target) => target.kind === 'chain' && target.id === id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('settings:get', () => {
    const s = settings.get();
    const target = targets.defaultTarget();
    return {
      ok: true,
      autostart: autostart.autostartEnabled(app),
      autoconnect: !!s.autoconnect,
      defaultTarget: target,
      profiles: profiles.list(),
      chains: chains.list(),
    };
  });

  ipcMain.handle('settings:setAutostart', (_e, enabled) => {
    try {
      actions.setAutostart(enabled);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('settings:setAutoconnect', (_e, enabled) => {
    return actions.setAutoconnect(enabled);
  });

  ipcMain.handle('settings:setDefaultTarget', (_e, kind, id) => {
    return actions.setDefaultTarget(kind, id);
  });
}

module.exports = { registerIpc };