const editor = document.getElementById('editor');
const chainEditor = document.getElementById('chainEditor');
const chainName = document.getElementById('chainName');
const chainBindAddress = document.getElementById('chainBindAddress');
const chainAddSelect = document.getElementById('chainAddSelect');
const btnChainAdd = document.getElementById('btnChainAdd');
const chainProfileList = document.getElementById('chainProfileList');
const chainEmpty = document.getElementById('chainEmpty');
const btnSave = document.getElementById('btnSave');
const btnValidate = document.getElementById('btnValidate');
const btnStart = document.getElementById('btnStart');
const btnClearLog = document.getElementById('btnClearLog');
const btnNewProfile = document.getElementById('btnNewProfile');
const btnNewChain = document.getElementById('btnNewChain');
const silentCb = document.getElementById('silent');
const logPane = document.getElementById('logPane');
const metricsPane = document.getElementById('metricsPane');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const proxyAddr = document.getElementById('proxyAddr');
const profileList = document.getElementById('profileList');
const chainList = document.getElementById('chainList');
const chkAutostart = document.getElementById('chkAutostart');
const chkAutoconnect = document.getElementById('chkAutoconnect');
const selectDefaultTarget = document.getElementById('selectDefaultTarget');

const api = window.wireproxyApi;

let profiles = [];
let chains = [];
let mode = 'profile';
let selectedId = null;
let selectedChainId = null;
let chainProfileIds = [];
let chainDirty = false;
let state = 'stopped';
let activeProfileId = null;
let activeIds = [];
let chainId = null;
let dirty = false;
let defaultTarget = null;
let lastStatusKey = '';

function statusKey() {
  return state + '|' + activeIds.join(',') + '|' + (chainId || '');
}

const STATE_LABEL = {
  stopped: 'Stopped',
  validating: 'Validating...',
  connecting: 'Connecting...',
  connected: 'Connected',
  degraded: 'Connected (degraded)',
  error: 'Error',
};

function getProfileName(id) {
  const p = profiles.find((x) => x.id === id);
  return p ? p.name : null;
}

function getChainName(id) {
  const c = chains.find((x) => x.id === id);
  return c ? c.name : null;
}

function parseProxyAddr(text) {
  const match = text.match(/\[(Socks5|http)\][\s\S]*?BindAddress\s*=\s*([^\r\n#]+)/i);
  proxyAddr.textContent = match ? (match[1] + ' at ' + match[2].trim()) : '';
}

function appendLog(line) {
  let text = line;
  if (logPane.textContent) text = '\n' + text;
  logPane.textContent += text;
  while (logPane.textContent.length > 100000) {
    logPane.textContent = logPane.textContent.slice(20000);
  }
  logPane.scrollTop = logPane.scrollHeight;
}

function updateDirtyUI() {
  const label = (mode === 'chain' ? chainDirty : dirty) ? 'Save* (Ctrl+S)' : 'Save (Ctrl+S)';
  btnSave.textContent = label;
}

function running() {
  return state !== 'stopped' && state !== 'error';
}

function updateStartBtn() {
  let active = false;
  if (mode === 'profile') {
    active = selectedId !== null && activeIds.includes(selectedId);
  } else {
    active = selectedChainId !== null && chainId === selectedChainId;
  }
  btnStart.textContent = running() && active ? 'Stop' : 'Start';
  btnValidate.disabled = mode !== 'profile';
}

// renderLists redraws the sidebars; renderChainEditor is intentionally NOT called
// here — rebuilding the editor on every 1s status poll would clobber the dropdowns
// the user may be interacting with. It is only re-rendered on explicit actions.
function renderLists() {
  renderList();
  renderChainList();
  updateStartBtn();
}

function renderListsAndDefault() {
  renderLists();
  renderDefaultSelect();
}

function renderList() {
  profileList.textContent = '';
  for (const p of profiles) {
    const li = document.createElement('li');
    const isSelected = mode === 'profile' && p.id === selectedId;
    li.className = 'profile-item' + (isSelected ? ' selected' : '');
    li.dataset.id = p.id;

    const dot = document.createElement('span');
    dot.className = 'profile-dot';
    if (activeIds.includes(p.id) && running()) {
      dot.classList.add(state);
    }

    const name = document.createElement('span');
    name.className = 'profile-name';
    name.textContent = p.name;
    name.title = p.name;

    const del = document.createElement('button');
    del.className = 'profile-del';
    del.textContent = '\u00d7';
    del.title = 'Delete profile';

    li.appendChild(dot);
    li.appendChild(name);
    li.appendChild(del);
    profileList.appendChild(li);
  }
  updateStartBtn();
}

function renderChainList() {
  chainList.textContent = '';
  for (const c of chains) {
    const li = document.createElement('li');
    const isSelected = mode === 'chain' && c.id === selectedChainId;
    li.className = 'profile-item' + (isSelected ? ' selected' : '');
    li.dataset.id = c.id;

    const dot = document.createElement('span');
    dot.className = 'profile-dot';
    if (c.id === chainId && running()) {
      dot.classList.add(state);
    }

    const name = document.createElement('span');
    name.className = 'profile-name';
    name.textContent = c.name;
    name.title = c.name;

    const del = document.createElement('button');
    del.className = 'profile-del';
    del.textContent = '\u00d7';
    del.title = 'Delete chain';

    li.appendChild(dot);
    li.appendChild(name);
    li.appendChild(del);
    chainList.appendChild(li);
  }
  updateStartBtn();
}

function renderChainEditor() {
  const chain = chains.find((x) => x.id === selectedChainId);
  chainProfileList.textContent = '';
  if (!chain) {
    chainEmpty.classList.add('hidden');
    return;
  }
  chainEmpty.classList.toggle('hidden', chainProfileIds.length > 0);
  chainAddSelect.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    opt.hidden = chainProfileIds.includes(p.id);
    chainAddSelect.appendChild(opt);
  }
  for (let i = 0; i < chainProfileIds.length; i++) {
    const pid = chainProfileIds[i];
    const li = document.createElement('li');
    li.className = 'chain-hop-item';

    const sel = document.createElement('select');
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    sel.value = pid;
    sel.title = 'Hop ' + (i + 1) + (i === 0 ? ' (outermost)' : i === chainProfileIds.length - 1 ? ' (exit)' : '');
    sel.addEventListener('change', () => {
      const value = sel.value;
      for (let j = 0; j < chainProfileIds.length; j++) {
        if (j !== i && chainProfileIds[j] === value) {
          appendLog('[gui] Profile is already in this chain');
          sel.value = pid;
          return;
        }
      }
      chainProfileIds[i] = value;
      chainDirty = true;
      renderChainEditor();
      updateDirtyUI();
    });

    const up = document.createElement('button');
    up.textContent = '\u2191';
    up.title = 'Move hop up (closer to the outermost hop)';
    up.disabled = i === 0;
    up.addEventListener('click', () => {
      if (i === 0) return;
      const t = chainProfileIds[i - 1];
      chainProfileIds[i - 1] = chainProfileIds[i];
      chainProfileIds[i] = t;
      chainDirty = true;
      renderChainEditor();
      updateDirtyUI();
    });

    const down = document.createElement('button');
    down.textContent = '\u2193';
    down.title = 'Move hop down';
    down.disabled = i === chainProfileIds.length - 1;
    down.addEventListener('click', () => {
      if (i === chainProfileIds.length - 1) return;
      const t = chainProfileIds[i + 1];
      chainProfileIds[i + 1] = chainProfileIds[i];
      chainProfileIds[i] = t;
      chainDirty = true;
      renderChainEditor();
      updateDirtyUI();
    });

    const remove = document.createElement('button');
    remove.className = 'hop-btn-remove';
    remove.textContent = '\u00d7';
    remove.title = 'Remove hop';
    remove.addEventListener('click', () => {
      chainProfileIds.splice(i, 1);
      chainDirty = true;
      renderChainEditor();
      updateDirtyUI();
    });

    li.appendChild(sel);
    li.appendChild(up);
    li.appendChild(down);
    li.appendChild(remove);
    chainProfileList.appendChild(li);
  }
}

function enterChainMode(id, chainData) {
  mode = 'chain';
  selectedChainId = id;
  const chain = chainData || chains.find((x) => x.id === id);
  chainProfileIds = chain ? [...chain.profileIds] : [];
  chainName.value = chain ? chain.name : '';
  chainBindAddress.value = chain ? (chain.bindAddress || '') : '';
  chainDirty = false;
  editor.classList.add('hidden');
  chainEditor.classList.remove('hidden');
  proxyAddr.textContent = '';
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
  mode = 'profile';
  selectedId = id;
  chainEditor.classList.add('hidden');
  editor.classList.remove('hidden');
  if (id) loadProfile(id);
  updateDirtyUI();
  renderListsAndDefault();
}

async function loadProfile(id) {
  const res = await api.profiles.get(id);
  if (res.ok) {
    editor.value = res.profile.content;
    dirty = false;
    updateDirtyUI();
    parseProxyAddr(res.profile.content);
  } else {
    appendLog('[gui] Failed to load profile: ' + res.error);
  }
}

async function switchProfile(id) {
  if (mode === 'profile' && id === selectedId) return;
  if (mode === 'profile' && dirty) {
    if (!window.confirm('Discard unsaved changes to the current profile?')) return;
  }
  enterProfileMode(id);
}

function startRename(id, whichList, finishApi) {
  const list = whichList === 'profiles' ? profileList : chainList;
  const item = list.querySelector('li[data-id="' + id + '"]');
  if (!item) return;
  const nameSpan = item.querySelector('.profile-name');
  const input = document.createElement('input');
  input.value = nameSpan.textContent;
  input.defaultValue = nameSpan.textContent;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();
  let done = false;

  const finish = async (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value && value !== input.defaultValue) {
      const res = await finishApi(id, value);
      if (!res.ok) appendLog('[gui] Rename failed: ' + res.error);
      else {
        const arr = whichList === 'profiles' ? profiles : chains;
        const item2 = arr.find((x) => x.id === id);
        if (item2) item2.name = value;
        if (whichList === 'chains' && mode === 'chain' && id === selectedChainId) {
          chainName.value = value;
        }
      }
    }
    renderListsAndDefault();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { finish(false); }
  });
  input.addEventListener('blur', () => finish(false));
}

async function deleteProfile(id) {
  const p = profiles.find((x) => x.id === id);
  const name = p ? p.name : 'this profile';
  const isRunning = activeIds.includes(id) && running();
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

  if (selectedId === id) {
    dirty = false;
    updateDirtyUI();
    selectedId = null;
  }
  const listRes = await api.profiles.list();
  if (listRes.ok) profiles = listRes.profiles;
  const chainsRes = await api.chains.list();
  if (chainsRes.ok) chains = chainsRes.chains;
  if (mode === 'profile') {
    if (!profiles.some((x) => x.id === selectedId)) {
      selectedId = profiles.length ? profiles[0].id : null;
      if (selectedId) await loadProfile(selectedId);
      else editor.value = '';
    }
  } else {
    const c = chains.find((x) => x.id === selectedChainId);
    if (c) {
      chainProfileIds = c.profileIds;
      chainDirty = false;
      renderChainEditor();
    }
  }
  renderListsAndDefault();
}

async function deleteChain(id) {
  const c = chains.find((x) => x.id === id);
  const name = c ? c.name : 'this chain';
  if (!window.confirm('Delete chain "' + name + '"?')) return;

  const res = await api.chains.remove(id);
  if (!res.ok) {
    appendLog('[gui] Delete failed: ' + res.error);
    return;
  }
  appendLog('[gui] Chain "' + name + '" deleted');

  chains = chains.filter((x) => x.id !== id);
  if (selectedChainId === id) {
    selectedChainId = null;
    mode = 'profile';
    chainId = null;
    if (profiles.length) {
      enterProfileMode(profiles[0].id);
    } else {
      chainEditor.classList.add('hidden');
      editor.classList.remove('hidden');
      editor.value = '';
    }
  }
  renderListsAndDefault();
}

async function saveProfile() {
  if (!selectedId) return;
  const res = await api.profiles.save(selectedId, editor.value);
  if (res.ok) {
    dirty = false;
    updateDirtyUI();
    appendLog('[gui] Profile saved');
  } else {
    appendLog('[gui] Save failed: ' + res.error);
  }
}

async function saveChain() {
  if (!selectedChainId) return;
  const name = chainName.value.trim() || 'Chain';
  if (chainProfileIds.length === 0) {
    appendLog('[gui] A chain needs at least one profile');
    return false;
  }
  const res = await api.chains.save(selectedChainId, name, chainProfileIds, chainBindAddress.value.trim());
  if (!res.ok) {
    appendLog('[gui] Chain save failed: ' + res.error);
    return false;
  }
  const c = chains.find((x) => x.id === selectedChainId);
  if (c) {
    c.name = name;
    c.profileIds = [...chainProfileIds];
    c.bindAddress = chainBindAddress.value.trim();
  }
  chainDirty = false;
  updateDirtyUI();
  renderListsAndDefault();
  appendLog('[gui] Chain saved');
  return true;
}

async function saveCurrent() {
  if (mode === 'profile') {
    await saveProfile();
    return true;
  }
  if (chainDirty) {
    return saveChain();
  }
  return true;
}

async function validateProfile() {
  if (!selectedId) return;
  appendLog('[gui] Validating config...');
  const res = await api.profiles.validate(selectedId, editor.value);
  appendLog(res.ok ? '[gui] Config OK' : '[gui] Validation failed:\n' + res.output);
}

async function startStop() {
  if (mode === 'profile' && !selectedId) return;
  if (mode === 'chain' && !selectedChainId) return;

  if (running()) {
    if (mode === 'profile' && activeIds.includes(selectedId)) {
      await api.vpn.stop();
      return;
    }
    if (mode === 'chain' && chainId === selectedChainId) {
      await api.vpn.stop();
      return;
    }
  }

  btnStart.disabled = true;
  try {
    let res;
    if (mode === 'profile') {
      res = await api.vpn.start({ id: selectedId, text: editor.value, silent: silentCb.checked });
    } else {
      if (!(await saveCurrent())) return;
      res = await api.vpn.start({ chainId: selectedChainId, silent: silentCb.checked });
    }
    if (res.ok) {
      dirty = false;
      chainDirty = false;
      updateDirtyUI();
    } else if (res.output !== 'Already running') {
      appendLog('[gui] Start failed: ' + res.output);
      setStatus('error');
    }
  } finally {
    btnStart.disabled = false;
  }
}

function setStatus(nextState) {
  state = nextState;
  statusDot.className = 'dot ' + state;
  let label = STATE_LABEL[state] || state;
  if (state !== 'stopped' && state !== 'error') {
    if (chainId) {
      const c = getChainName(chainId);
      if (c) label += ' \u2014 ' + c;
    } else {
      const n = getProfileName(activeProfileId);
      if (n) label += ' \u2014 ' + n;
    }
  }
  statusText.textContent = label;
  
  // Clear proxy address when stopped
  if (state === 'stopped' || state === 'error') {
    proxyAddr.textContent = '';
  }
  
  const key = statusKey();
  if (key !== lastStatusKey) {
    lastStatusKey = key;
    renderLists();
  } else {
    updateStartBtn();
  }
}

function renderDefaultSelect() {
  const current = defaultTarget;
  const currentValue = current ? (current.kind === 'chain' ? 'c:' : 'p:') + current.id : '';
  selectDefaultTarget.innerHTML = '';

  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Default: none';
  selectDefaultTarget.appendChild(none);

  for (const set of [
    { kind: 'profile', label: 'Profiles', items: profiles },
    { kind: 'chain', label: 'Chains', items: chains },
  ]) {
    const group = document.createElement('optgroup');
    group.label = set.label;
    for (const it of set.items) {
      const opt = document.createElement('option');
      opt.value = (set.kind === 'chain' ? 'c:' : 'p:') + it.id;
      opt.textContent = it.name;
      group.appendChild(opt);
    }
    selectDefaultTarget.appendChild(group);
  }

  selectDefaultTarget.value = currentValue;
  const hasDefault = !!selectDefaultTarget.value;
  chkAutoconnect.disabled = !hasDefault;
  if (!hasDefault) chkAutoconnect.checked = false;
}

function refreshDefaultSelect() {
  const t = defaultTarget;
  const exists = t && (
    (t.kind === 'profile' && profiles.some((p) => p.id === t.id)) ||
    (t.kind === 'chain' && chains.some((c) => c.id === t.id))
  );
  if (t && !exists) {
    defaultTarget = null;
    chkAutoconnect.checked = false;
    api.settings.setDefaultTarget(null, null);
  }
  renderDefaultSelect();
}

btnNewProfile.addEventListener('click', async () => {
  if (mode === 'profile' && dirty) {
    if (!window.confirm('Discard unsaved changes and create a new profile?')) return;
  }
  const res = await api.profiles.create();
  if (!res.ok) {
    appendLog('[gui] Failed to create profile: ' + res.error);
    return;
  }
  profiles.push({ id: res.profile.id, name: res.profile.name });
  mode = 'profile';
  selectedId = res.profile.id;
  dirty = false;
  updateDirtyUI();
  chainEditor.classList.add('hidden');
  editor.classList.remove('hidden');
  await loadProfile(res.profile.id);
  renderListsAndDefault();
  appendLog('[gui] Created ' + res.profile.name);
});

btnNewChain.addEventListener('click', async () => {
  const res = await api.chains.create();
  if (!res.ok) {
    appendLog('[gui] Failed to create chain: ' + res.error);
    return;
  }
  chains.push({ id: res.chain.id, name: res.chain.name, profileIds: [] });
  enterChainMode(res.chain.id);
  appendLog('[gui] Created ' + res.chain.name);
});

btnChainAdd.addEventListener('click', () => {
  const pid = chainAddSelect.value;
  if (!pid || chainProfileIds.includes(pid)) return;
  chainProfileIds.push(pid);
  chainDirty = true;
  renderChainEditor();
  updateDirtyUI();
});

btnSave.addEventListener('click', () => saveCurrent());
btnValidate.addEventListener('click', validateProfile);
btnStart.addEventListener('click', startStop);

btnClearLog.addEventListener('click', () => {
  logPane.textContent = '';
});

chkAutostart.addEventListener('change', async () => {
  const res = await api.settings.setAutostart(chkAutostart.checked);
  if (!res.ok) {
    chkAutostart.checked = !chkAutostart.checked;
    appendLog('[gui] Autostart failed: ' + res.error);
  }
});

chkAutoconnect.addEventListener('change', async () => {
  if (chkAutoconnect.checked && !defaultTarget) {
    chkAutoconnect.checked = false;
    appendLog('[gui] Select a default target first');
    return;
  }
  const res = await api.settings.setAutoconnect(chkAutoconnect.checked);
  if (!res.ok) {
    chkAutoconnect.checked = !chkAutoconnect.checked;
    appendLog('[gui] ' + res.error);
  }
});

selectDefaultTarget.addEventListener('change', async () => {
  const value = selectDefaultTarget.value;
  let kind = null;
  let id = null;
  if (value) {
    kind = value.startsWith('c:') ? 'chain' : 'profile';
    id = value.slice(2);
  }
  const res = await api.settings.setDefaultTarget(kind, id);
  if (res.ok) {
    defaultTarget = kind ? { kind, id } : null;
    if (!kind) chkAutoconnect.checked = false;
    chkAutoconnect.disabled = !kind;
  } else {
    appendLog('[gui] ' + res.error);
    renderDefaultSelect();
  }
});

chainName.addEventListener('input', () => {
  chainDirty = true;
  updateDirtyUI();
});

chainBindAddress.addEventListener('input', () => {
  chainDirty = true;
  updateDirtyUI();
});

editor.addEventListener('input', () => {
  parseProxyAddr(editor.value);
  if (!dirty) {
    dirty = true;
    updateDirtyUI();
  }
});

editor.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveCurrent();
  }
});

profileList.addEventListener('click', (e) => {
  const item = e.target.closest('li.profile-item');
  if (!item) return;
  if (e.target.classList.contains('profile-del')) {
    deleteProfile(item.dataset.id);
    return;
  }
  switchProfile(item.dataset.id);
});

profileList.addEventListener('dblclick', (e) => {
  if (e.target.classList.contains('profile-name')) {
    startRename(e.target.closest('li.profile-item').dataset.id, 'profiles', api.profiles.rename);
  }
});

chainList.addEventListener('click', (e) => {
  const item = e.target.closest('li.profile-item');
  if (!item) return;
  if (e.target.classList.contains('profile-del')) {
    deleteChain(item.dataset.id);
    return;
  }
  loadChain(item.dataset.id);
});

chainList.addEventListener('dblclick', (e) => {
  if (e.target.classList.contains('profile-name')) {
    startRename(e.target.closest('li.profile-item').dataset.id, 'chains', api.chains.rename);
  }
});

api.onEvent('vpn:status', ({ state: nextState, activeProfileId: aid, activeIds: aids, chainId: cid }) => {
  activeProfileId = aid;
  if (aids) activeIds = aids;
  if (cid !== undefined) chainId = cid;
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
  if (chainId && state === 'connected') {
    const exitHop = payload.hops.find((h, i) => i === payload.hops.length - 1);
    if (exitHop) {
      if (exitHop.socksAddr) {
        proxyAddr.textContent = 'Socks5 at ' + exitHop.socksAddr;
      } else if (exitHop.socksPort) {
        proxyAddr.textContent = 'Socks5 at 127.0.0.1:' + exitHop.socksPort;
      }
    }
  }
});

api.onEvent('vpn:metrics', ({ text }) => {
  metricsPane.textContent = text;
});

(async () => {
  const listRes = await api.profiles.list();
  const chainsRes = await api.chains.list();
  if (listRes.ok) profiles = listRes.profiles;
  if (chainsRes.ok) chains = chainsRes.chains;
  const setRes = await api.settings.get();
  if (setRes.ok) {
    defaultTarget = setRes.defaultTarget || null;
    chkAutostart.checked = !!setRes.autostart;
    chkAutoconnect.checked = !!setRes.autoconnect;
  }
  if (!profiles.length) {
    const created = await api.profiles.create();
    if (created.ok) profiles = [{ id: created.profile.id, name: created.profile.name }];
  }
  if (profiles.length) {
    enterProfileMode(profiles[0].id);
  } else {
    chainEditor.classList.add('hidden');
    editor.classList.remove('hidden');
  }
  refreshDefaultSelect();

  const st = await api.vpn.state();
  activeProfileId = st.activeProfileId;
  if (st.activeIds) activeIds = st.activeIds;
  if (st.chainId) chainId = st.chainId;
  setStatus(st.state);
})();