// Path resolution for the wireproxy binary. No Electron imports; opts carry
// the app-specific values ({ isPackaged, resourcesPath, dirname }).

const path = require('path');

function resolveWireproxyPath(opts) {
  return opts.isPackaged
    ? path.join(opts.resourcesPath, 'bin', 'wireproxy.exe')
    : path.join(opts.dirname, 'bin', 'wireproxy.exe');
}

module.exports = { resolveWireproxyPath };