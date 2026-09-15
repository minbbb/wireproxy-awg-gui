// Electron main process bootstrap: single-instance lock, app lifecycle, window
// and tray wiring, dependency composition, and the event bridge between the
// pure-Node VpnEngine and the renderer/tray. All real logic lives in core/, 
// services/ and ipc/.

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const profiles = require('./core/profiles');
const settings = require('./core/settings');
const chains = require('./core/chains');
const VpnEngine = require('./core/vpn-engine');
const { resolveWireproxyPath } = require('./core/wireproxy-path');
const { DERIVED_CONF_DIRNAME } = require('./core/derived-config');
const { removeFile } = require('./core/process-utils');
const { createTargetService } = require('./services/targets');
const { autostartEnabled, applyAutostart } = require('./services/autostart');
const { createSettingsActions } = require('./services/settings-actions');
const { registerIpc } = require('./ipc/handlers');
const TrayController = require('./tray');

const STATE_LABEL = {
  stopped: 'Stopped',
  validating: 'Validating...',
  connecting: 'Connecting...',
  connected: 'Connected',
  degraded: 'Connected (degraded)',
  error: 'Error',
};

let mainWindow = null;
let engine = null;
let targets = null;
let autostart = null;
let settingsActions = null;
let trayCtrl = null;
let quitting = false;
let runDir = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function log(line) {
  sendToRenderer('vpn:log', { line });
}

function syncTray() {
  if (trayCtrl) trayCtrl.sync();
}

function trayState() {
  const target = targets.defaultTarget();
  return {
    state: engine.stateValue,
    stateLabel: STATE_LABEL[engine.stateValue] || engine.stateValue,
    windowVisible: !!(mainWindow && mainWindow.isVisible()),
    running: engine.hasRunningHop(),
    autostart: autostart.autostartEnabled(app),
    autoconnect: !!settings.get().autoconnect,
    defaultTargetName: target ? targets.targetName(target.kind, target.id) : null,
    hasDefaultTarget: !!(target && targets.targetName(target.kind, target.id)),
  };
}

function maybeAutoConnect() {
  const s = settings.get();
  if (!s.autoconnect) return;
  const target = targets.defaultTarget();
  if (!target || !targets.targetExists(target.kind, target.id)) {
    log('[gui] Auto-connect skipped: default target is missing');
    return;
  }
  if (engine.hasRunningHop()) {
    log('[gui] Auto-connect skipped: connection already running');
    return;
  }
  const name = targets.targetName(target.kind, target.id);
  log('[gui] Auto-connecting "' + name + '"...');
  if (target.kind === 'chain') {
    engine.startChain(target.id, false);
  } else {
    const profile = profiles.get(target.id);
    engine.startVpn(profile.id, profile.content, false);
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
    if (engine) engine.shutdown();
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

    engine = new VpnEngine({
      wireproxyPath: resolveWireproxyPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        dirname: __dirname,
      }),
      runDir,
      profiles,
      chains,
    });
    engine.on('status', (payload) => {
      sendToRenderer('vpn:status', payload);
      syncTray();
    });
    engine.on('log', (line) => sendToRenderer('vpn:log', { line }));
    engine.on('readyz', (payload) => sendToRenderer('vpn:readyz', payload));
    engine.on('metrics', (payload) => sendToRenderer('vpn:metrics', payload));

    targets = createTargetService({ settings, profiles, chains });
    autostart = { autostartEnabled, applyAutostart };
    settingsActions = createSettingsActions({
      app,
      settings,
      targets,
      autostart,
      onSync: syncTray,
    });
    registerIpc({
      ipcMain,
      app,
      engine,
      profiles,
      chains,
      settings,
      targets,
      autostart,
      actions: settingsActions,
    });

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
        if (engine.hasRunningHop()) {
          engine.stop();
          return;
        }
        const target = targets.defaultTarget();
        if (!target || !targets.targetExists(target.kind, target.id)) return;
        if (target.kind === 'chain') {
          engine.startChain(target.id, false);
        } else {
          const profile = profiles.get(target.id);
          engine.startVpn(profile.id, profile.content, false);
        }
      },
      onSetAutostart: (enabled) => {
        try {
          settingsActions.setAutostart(enabled);
        } catch (e) {
          log('[gui] Autostart failed: ' + e.message);
          syncTray();
        }
      },
      onSetAutoconnect: (enabled) => {
        settingsActions.setAutoconnect(enabled);
      },
      onQuit: () => {
        app.quit();
      },
    });

    Menu.setApplicationMenu(null);
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