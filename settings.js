'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  autostart: false,
  autoconnect: false,
  defaultProfileId: null,
};

let filePath = null;

function init(userDataPath) {
  filePath = path.join(userDataPath, 'settings.json');
}

function settingsPath() {
  if (!filePath) throw new Error('settings.init() not called');
  return filePath;
}

function get() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = { ...get(), ...patch };
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, settingsPath());
  return next;
}

module.exports = {
  DEFAULTS,
  init,
  get,
  save,
};