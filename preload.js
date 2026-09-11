const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wireproxyApi', {
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    get: (id) => ipcRenderer.invoke('profiles:get', id),
    create: () => ipcRenderer.invoke('profiles:create'),
    save: (id, text) => ipcRenderer.invoke('profiles:save', id, text),
    validate: (id, text) => ipcRenderer.invoke('profiles:validate', id, text),
    rename: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
    remove: (id) => ipcRenderer.invoke('profiles:delete', id),
  },
  vpn: {
    start: (opts) => ipcRenderer.invoke('vpn:start', opts),
    stop: () => ipcRenderer.invoke('vpn:stop'),
    state: () => ipcRenderer.invoke('vpn:state'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setAutostart: (enabled) => ipcRenderer.invoke('settings:setAutostart', enabled),
    setAutoconnect: (enabled) => ipcRenderer.invoke('settings:setAutoconnect', enabled),
    setDefaultProfile: (id) => ipcRenderer.invoke('settings:setDefaultProfile', id),
  },
  onEvent: (channel, callback) => {
    const allowed = ['vpn:status', 'vpn:log', 'vpn:readyz', 'vpn:metrics'];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});