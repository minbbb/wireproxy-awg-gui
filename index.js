const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles');

const WIREPROXY_PATH = path.join(__dirname, 'bin/wireproxy.exe');

let mainWindow = null;
let child = null;
let healthPort = null;
let healthTimer = null;
let state = 'stopped';
let activeProfileId = null;

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
  sendToRenderer('vpn:status', { state, activeProfileId });
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

function httpGet(httpPath) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: healthPort, path: httpPath, timeout: 1500 },
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
  if (!child || healthPort === null) return;
  const readyz = await httpGet('/readyz');
  if (!child || healthPort === null) return;
  if (readyz.error) {
    if (child.exitCode === null) setState('connecting');
    return;
  }
  if (readyz.status === 200) setState('connected');
  else if (readyz.status === 503) setState('degraded');
  sendToRenderer('vpn:readyz', readyz);
  const metrics = await httpGet('/metrics');
  if (!child || healthPort === null) return;
  if (!metrics.error && metrics.status === 200) {
    sendToRenderer('vpn:metrics', { text: metrics.body });
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

function cleanupRunning() {
  stopHealthPolling();
  child = null;
  healthPort = null;
  activeProfileId = null;
}

function stopVpn() {
  if (child && child.exitCode === null) {
    log('[gui] Stopping wireproxy...');
    try {
      child.kill();
    } catch (e) {
      log('[gui] Failed to stop wireproxy: ' + e.message);
    }
  } else {
    cleanupRunning();
    setState('stopped');
  }
}

app.on('before-quit', () => {
  if (child && child.exitCode === null) {
    child.kill();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.whenReady().then(() => {
  profiles.init(app.getPath('userData'));
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'wireproxy-awg GUI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
});

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
    if (activeProfileId === id && child && child.exitCode === null) {
      log('[gui] Stopping connection before delete...');
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    profiles.remove(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('vpn:start', async (_e, opts) => {
  const text = (opts && opts.text) || '';
  const silent = !!(opts && opts.silent);
  const id = opts && opts.id;
  const profile = profiles.get(id);
  if (!profile) return { ok: false, output: 'Profile not found' };

  if (child && child.exitCode === null) {
    if (activeProfileId === id) return { ok: false, output: 'Already running' };
    log('[gui] Stopping current connection to switch...');
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }

  activeProfileId = id;
  setState('validating');

  try {
    profiles.save(id, text);
  } catch (e) {
    cleanupRunning();
    setState('error');
    return { ok: false, output: 'Failed to save config: ' + e.message };
  }

  const test = await runConfigTest(profiles.confPath(id));
  if (test.code !== 0) {
    setState('error');
    const output = test.stderr || test.stdout || 'Config error (code ' + test.code + ')';
    log('[gui] Validation failed: ' + output);
    return { ok: false, output };
  }
  log('[gui] Config OK (' + profile.name + ')');

  try {
    healthPort = await getFreePort();
  } catch (e) {
    cleanupRunning();
    setState('error');
    log('[gui] Failed to allocate health port: ' + e.message);
    return { ok: false, output: e.message };
  }

  return new Promise((resolve) => {
    const args = ['-c', profiles.confPath(id), '-i', `127.0.0.1:${healthPort}`];
    if (silent) args.push('-s');
    const proc = spawn(WIREPROXY_PATH, args, { windowsHide: true });
    child = proc;
    proc.stdout.on('data', (d) => { log(d.toString().replace(/\s+$/, '')); });
    proc.stderr.on('data', (d) => { log(d.toString().replace(/\s+$/, '')); });
    proc.on('error', (err) => {
      log('[gui] Failed to launch wireproxy: ' + err.message);
      cleanupRunning();
      setState('error');
      resolve({ ok: false, output: err.message });
    });
    proc.on('exit', (code) => {
      log('[gui] wireproxy exited (code ' + code + ')');
      stopHealthPolling();
      if (child === proc) {
        cleanupRunning();
        setState('stopped');
      }
      resolve({ ok: false, output: 'Process exited with code ' + code });
    });
    setState('connecting');
    startHealthPolling();
    log('[gui] wireproxy started (PID ' + proc.pid + ', health port ' + healthPort + ')');
    resolve({ ok: true });
  });
});

ipcMain.handle('vpn:stop', () => {
  stopVpn();
  return { ok: true };
});

ipcMain.handle('vpn:state', () => {
  return { state, running: !!(child && child.exitCode === null), activeProfileId, healthPort };
});