// Windows login-item (autostart) helpers. `app` is the Electron app object,
// injected so this module stays Electron-import-free.

// The portable build MUST pass the runtime exe path: in a portable build the
// launched exe lives in a temp dir, so the Run key must point at
// PORTABLE_EXECUTABLE_FILE or it would reference the wrong path.
function autostartEnabled(app) {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) return app.getLoginItemSettings({ path: portable }).openAtLogin;
  return app.getLoginItemSettings().openAtLogin;
}

function applyAutostart(app, enabled) {
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

module.exports = {
  autostartEnabled,
  applyAutostart,
};