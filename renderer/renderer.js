// Renderer entry point: CRUD/actions, settings toggles, vpn:* event wiring and
// startup bootstrap. Rendering and DOM helpers live in ui.js; shared state in
// state.js (both loaded before this file).
(function () {
  const App = window.WGApp;
  const api = window.wireproxyApi;
  const s = App.s;
  const el = App.el;
  const ui = App.ui;

  const {
    running,
    parseProxyAddr,
    appendLog,
    updateDirtyUI,
    renderListsAndDefault,
    renderChainEditor,
    setStatus,
    renderDefaultSelect,
    bindList,
  } = ui;

  function enterChainMode(id, chainData) {
    s.mode = 'chain';
    s.selectedChainId = id;
    const chain = chainData || s.chains.find((x) => x.id === id);
    s.chainProfileIds = chain ? [...chain.profileIds] : [];
    el.chainName.value = chain ? chain.name : '';
    el.chainBindAddress.value = chain ? (chain.bindAddress || '') : '';
    s.chainDirty = false;
    el.editor.classList.add('hidden');
    el.chainEditor.classList.remove('hidden');
    el.proxyAddr.textContent = '';
    updateDirtyUI();
    renderChainEditor();
    renderListsAndDefault();
  }

  async function loadChain(id) {
    const res = await api.chains.get(id);
    if (!res.ok) {
      appendLog('[gui] Failed to load chain: ' + res.error);
      return;
    }
    enterChainMode(id, res.chain);
  }

  function enterProfileMode(id) {
    s.mode = 'profile';
    s.selectedId = id;
    el.chainEditor.classList.add('hidden');
    el.editor.classList.remove('hidden');
    if (id) loadProfile(id);
    updateDirtyUI();
    renderListsAndDefault();
  }

  async function loadProfile(id) {
    const res = await api.profiles.get(id);
    if (res.ok) {
      el.editor.value = res.profile.content;
      s.dirty = false;
      updateDirtyUI();
      parseProxyAddr(res.profile.content);
    } else {
      appendLog('[gui] Failed to load profile: ' + res.error);
    }
  }

  async function switchProfile(id) {
    if (s.mode === 'profile' && id === s.selectedId) return;
    if (s.mode === 'profile' && s.dirty) {
      if (!window.confirm('Discard unsaved changes to the current profile?')) return;
    }
    enterProfileMode(id);
  }

  async function deleteProfile(id) {
    const p = s.profiles.find((x) => x.id === id);
    const name = p ? p.name : 'this profile';
    const isRunning = s.activeIds.includes(id) && running();
    const msg = isRunning
      ? 'Profile "' + name + '" is part of the running connection. Stop it and delete the profile?'
      : 'Delete profile "' + name + '"?';
    if (!window.confirm(msg)) return;

    const res = await api.profiles.remove(id);
    if (!res.ok) {
      appendLog('[gui] Delete failed: ' + res.error);
      return;
    }
    appendLog('[gui] Profile "' + name + '" deleted');

    if (s.selectedId === id) {
      s.dirty = false;
      updateDirtyUI();
      s.selectedId = null;
    }
    const listRes = await api.profiles.list();
    if (listRes.ok) s.profiles = listRes.profiles;
    const chainsRes = await api.chains.list();
    if (chainsRes.ok) s.chains = chainsRes.chains;
    if (s.mode === 'profile') {
      if (!s.profiles.some((x) => x.id === s.selectedId)) {
        s.selectedId = s.profiles.length ? s.profiles[0].id : null;
        if (s.selectedId) await loadProfile(s.selectedId);
        else el.editor.value = '';
      }
    } else {
      const c = s.chains.find((x) => x.id === s.selectedChainId);
      if (c) {
        s.chainProfileIds = c.profileIds;
        s.chainDirty = false;
        renderChainEditor();
      }
    }
    renderListsAndDefault();
  }

  async function deleteChain(id) {
    const c = s.chains.find((x) => x.id === id);
    const name = c ? c.name : 'this chain';
    if (!window.confirm('Delete chain "' + name + '"?')) return;

    const res = await api.chains.remove(id);
    if (!res.ok) {
      appendLog('[gui] Delete failed: ' + res.error);
      return;
    }
    appendLog('[gui] Chain "' + name + '" deleted');

    s.chains = s.chains.filter((x) => x.id !== id);
    if (s.selectedChainId === id) {
      s.selectedChainId = null;
      s.mode = 'profile';
      s.chainId = null;
      if (s.profiles.length) {
        enterProfileMode(s.profiles[0].id);
      } else {
        el.chainEditor.classList.add('hidden');
        el.editor.classList.remove('hidden');
        el.editor.value = '';
      }
    }
    renderListsAndDefault();
  }

  async function saveProfile() {
    if (!s.selectedId) return;
    const res = await api.profiles.save(s.selectedId, el.editor.value);
    if (res.ok) {
      s.dirty = false;
      updateDirtyUI();
      appendLog('[gui] Profile saved');
    } else {
      appendLog('[gui] Save failed: ' + res.error);
    }
  }

  async function saveChain() {
    if (!s.selectedChainId) return;
    const name = el.chainName.value.trim() || 'Chain';
    if (s.chainProfileIds.length === 0) {
      appendLog('[gui] A chain needs at least one profile');
      return false;
    }
    const res = await api.chains.save(s.selectedChainId, name, s.chainProfileIds, el.chainBindAddress.value.trim());
    if (!res.ok) {
      appendLog('[gui] Chain save failed: ' + res.error);
      return false;
    }
    const c = s.chains.find((x) => x.id === s.selectedChainId);
    if (c) {
      c.name = name;
      c.profileIds = [...s.chainProfileIds];
      c.bindAddress = el.chainBindAddress.value.trim();
    }
    s.chainDirty = false;
    updateDirtyUI();
    renderListsAndDefault();
    appendLog('[gui] Chain saved');
    return true;
  }

  async function saveCurrent() {
    if (s.mode === 'profile') {
      await saveProfile();
      return true;
    }
    if (s.chainDirty) {
      return saveChain();
    }
    return true;
  }

  async function validateProfile() {
    if (!s.selectedId) return;
    appendLog('[gui] Validating config...');
    const res = await api.profiles.validate(s.selectedId, el.editor.value);
    appendLog(res.ok ? '[gui] Config OK' : '[gui] Validation failed:\n' + res.output);
  }

  async function startStop() {
    if (s.mode === 'profile' && !s.selectedId) return;
    if (s.mode === 'chain' && !s.selectedChainId) return;

    if (running()) {
      if (s.mode === 'profile' && s.activeIds.includes(s.selectedId)) {
        await api.vpn.stop();
        return;
      }
      if (s.mode === 'chain' && s.chainId === s.selectedChainId) {
        await api.vpn.stop();
        return;
      }
    }

    el.btnStart.disabled = true;
    try {
      let res;
      if (s.mode === 'profile') {
        res = await api.vpn.start({ id: s.selectedId, text: el.editor.value, silent: el.silentCb.checked });
      } else {
        if (!(await saveCurrent())) return;
        res = await api.vpn.start({ chainId: s.selectedChainId, silent: el.silentCb.checked });
      }
      if (res.ok) {
        s.dirty = false;
        s.chainDirty = false;
        updateDirtyUI();
      } else if (res.output !== 'Already running') {
        appendLog('[gui] Start failed: ' + res.output);
        setStatus('error');
      }
    } finally {
      el.btnStart.disabled = false;
    }
  }

  function refreshDefaultSelect() {
    const t = s.defaultTarget;
    const exists = t && (
      (t.kind === 'profile' && s.profiles.some((p) => p.id === t.id)) ||
      (t.kind === 'chain' && s.chains.some((c) => c.id === t.id))
    );
    if (t && !exists) {
      s.defaultTarget = null;
      el.chkAutoconnect.checked = false;
      api.settings.setDefaultTarget(null, null);
    }
    renderDefaultSelect();
  }

  // ---- Event wiring ----

  el.btnNewProfile.addEventListener('click', async () => {
    if (s.mode === 'profile' && s.dirty) {
      if (!window.confirm('Discard unsaved changes and create a new profile?')) return;
    }
    const res = await api.profiles.create();
    if (!res.ok) {
      appendLog('[gui] Failed to create profile: ' + res.error);
      return;
    }
    s.profiles.push({ id: res.profile.id, name: res.profile.name });
    s.mode = 'profile';
    s.selectedId = res.profile.id;
    s.dirty = false;
    updateDirtyUI();
    el.chainEditor.classList.add('hidden');
    el.editor.classList.remove('hidden');
    await loadProfile(res.profile.id);
    renderListsAndDefault();
    appendLog('[gui] Created ' + res.profile.name);
  });

  el.btnNewChain.addEventListener('click', async () => {
    const res = await api.chains.create();
    if (!res.ok) {
      appendLog('[gui] Failed to create chain: ' + res.error);
      return;
    }
    s.chains.push({ id: res.chain.id, name: res.chain.name, profileIds: [] });
    enterChainMode(res.chain.id);
    appendLog('[gui] Created ' + res.chain.name);
  });

  el.btnChainAdd.addEventListener('click', () => {
    const pid = el.chainAddSelect.value;
    if (!pid || s.chainProfileIds.includes(pid)) return;
    s.chainProfileIds.push(pid);
    s.chainDirty = true;
    renderChainEditor();
    updateDirtyUI();
  });

  el.btnSave.addEventListener('click', () => saveCurrent());
  el.btnValidate.addEventListener('click', validateProfile);
  el.btnStart.addEventListener('click', startStop);

  el.btnClearLog.addEventListener('click', () => {
    el.logPane.textContent = '';
  });

  el.chkAutostart.addEventListener('change', async () => {
    const res = await api.settings.setAutostart(el.chkAutostart.checked);
    if (!res.ok) {
      el.chkAutostart.checked = !el.chkAutostart.checked;
      appendLog('[gui] Autostart failed: ' + res.error);
    }
  });

  el.chkAutoconnect.addEventListener('change', async () => {
    if (el.chkAutoconnect.checked && !s.defaultTarget) {
      el.chkAutoconnect.checked = false;
      appendLog('[gui] Select a default target first');
      return;
    }
    const res = await api.settings.setAutoconnect(el.chkAutoconnect.checked);
    if (!res.ok) {
      el.chkAutoconnect.checked = !el.chkAutoconnect.checked;
      appendLog('[gui] ' + res.error);
    }
  });

  el.selectDefaultTarget.addEventListener('change', async () => {
    const value = el.selectDefaultTarget.value;
    let kind = null;
    let id = null;
    if (value) {
      kind = value.startsWith('c:') ? 'chain' : 'profile';
      id = value.slice(2);
    }
    const res = await api.settings.setDefaultTarget(kind, id);
    if (res.ok) {
      s.defaultTarget = kind ? { kind, id } : null;
      if (!kind) el.chkAutoconnect.checked = false;
      el.chkAutoconnect.disabled = !kind;
    } else {
      appendLog('[gui] ' + res.error);
      renderDefaultSelect();
    }
  });

  el.chainName.addEventListener('input', () => {
    s.chainDirty = true;
    updateDirtyUI();
  });

  el.chainBindAddress.addEventListener('input', () => {
    s.chainDirty = true;
    updateDirtyUI();
  });

  el.editor.addEventListener('input', () => {
    parseProxyAddr(el.editor.value);
    if (!s.dirty) {
      s.dirty = true;
      updateDirtyUI();
    }
  });

  el.editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrent();
    }
  });

  bindList(el.profileList, 'profiles', {
    onDelete: deleteProfile,
    onSelect: switchProfile,
    renameApi: api.profiles.rename,
  });

  bindList(el.chainList, 'chains', {
    onDelete: deleteChain,
    onSelect: loadChain,
    renameApi: api.chains.rename,
  });

  // ---- vpn:* push events ----

  api.onEvent('vpn:status', ({ state: nextState, activeProfileId: aid, activeIds: aids, chainId: cid }) => {
    s.activeProfileId = aid;
    if (aids) s.activeIds = aids;
    if (cid !== undefined) s.chainId = cid;
    if (nextState === 'stopped' || nextState === 'error') {
      el.metricsPane.textContent = '';
    }
    setStatus(nextState);
  });

  api.onEvent('vpn:log', ({ line }) => appendLog(line));

  api.onEvent('vpn:readyz', (payload) => {
    if (!payload || !payload.hops) return;
    const parts = payload.hops.map((h) => {
      const label = h.name || h.profileId;
      const status = h.status || h.error;
      const port = h.socksPort ? ':' + h.socksPort : '';
      return label + port + '=' + status;
    });
    appendLog('[readyz] ' + parts.join('  '));

    // Update header proxy address when chain is connected
    if (s.chainId && s.state === 'connected') {
      const exitHop = payload.hops.find((h, i) => i === payload.hops.length - 1);
      if (exitHop) {
        if (exitHop.socksAddr) {
          el.proxyAddr.textContent = 'Socks5 at ' + exitHop.socksAddr;
        } else if (exitHop.socksPort) {
          el.proxyAddr.textContent = 'Socks5 at 127.0.0.1:' + exitHop.socksPort;
        }
      }
    }
  });

  api.onEvent('vpn:metrics', ({ text }) => {
    el.metricsPane.textContent = text;
  });

  // ---- Startup bootstrap ----

  (async () => {
    const infoRes = await api.app.info();
    if (infoRes.ok) document.getElementById('appVersion').textContent = 'v' + infoRes.version;
    const listRes = await api.profiles.list();
    const chainsRes = await api.chains.list();
    if (listRes.ok) s.profiles = listRes.profiles;
    if (chainsRes.ok) s.chains = chainsRes.chains;
    const setRes = await api.settings.get();
    if (setRes.ok) {
      s.defaultTarget = setRes.defaultTarget || null;
      el.chkAutostart.checked = !!setRes.autostart;
      el.chkAutoconnect.checked = !!setRes.autoconnect;
    }
    if (!s.profiles.length) {
      const created = await api.profiles.create();
      if (created.ok) s.profiles = [{ id: created.profile.id, name: created.profile.name }];
    }
    if (s.profiles.length) {
      enterProfileMode(s.profiles[0].id);
    } else {
      el.chainEditor.classList.add('hidden');
      el.editor.classList.remove('hidden');
    }
    refreshDefaultSelect();

    const st = await api.vpn.state();
    s.activeProfileId = st.activeProfileId;
    if (st.activeIds) s.activeIds = st.activeIds;
    if (st.chainId) s.chainId = st.chainId;
    setStatus(st.state);
  })();
})();