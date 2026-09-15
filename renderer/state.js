// Shared renderer state + display labels. Classic-script namespace
// (window.WGApp); loaded BEFORE ui.js and renderer.js.
(function () {
  const App = window.WGApp || (window.WGApp = {});

  App.STATE_LABEL = {
    stopped: 'Stopped',
    validating: 'Validating...',
    connecting: 'Connecting...',
    connected: 'Connected',
    degraded: 'Connected (degraded)',
    error: 'Error',
  };

  // Mutable UI state. Mirrors the fields the main process pushes via vpn:*.
  App.s = {
    profiles: [],
    chains: [],
    mode: 'profile',
    selectedId: null,
    selectedChainId: null,
    chainProfileIds: [],
    chainDirty: false,
    state: 'stopped',
    activeProfileId: null,
    activeIds: [],
    chainId: null,
    dirty: false,
    defaultTarget: null,
    lastStatusKey: '',
  };

  App.statusKey = function () {
    const s = App.s;
    return s.state + '|' + s.activeIds.join(',') + '|' + (s.chainId || '');
  };

  App.getProfileName = function (id) {
    const p = App.s.profiles.find((x) => x.id === id);
    return p ? p.name : null;
  };

  App.getChainName = function (id) {
    const c = App.s.chains.find((x) => x.id === id);
    return c ? c.name : null;
  };
})();