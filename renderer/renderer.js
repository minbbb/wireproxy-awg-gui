const editor = document.getElementById('editor');
const btnSave = document.getElementById('btnSave');
const btnValidate = document.getElementById('btnValidate');
const btnStart = document.getElementById('btnStart');
const btnClearLog = document.getElementById('btnClearLog');
const btnNewProfile = document.getElementById('btnNewProfile');
const silentCb = document.getElementById('silent');
const logPane = document.getElementById('logPane');
const metricsPane = document.getElementById('metricsPane');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const proxyAddr = document.getElementById('proxyAddr');
const profileList = document.getElementById('profileList');
const chkAutostart = document.getElementById('chkAutostart');
const chkAutoconnect = document.getElementById('chkAutoconnect');
const selectDefaultProfile = document.getElementById('selectDefaultProfile');

const api = window.wireproxyApi;

let profiles = [];
let selectedId = null;
let state = 'stopped';
let activeProfileId = null;
let dirty = false;
let defaultProfileId = null;

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
  btnSave.textContent = dirty ? 'Save* (Ctrl+S)' : 'Save (Ctrl+S)';
}

function updateStartBtn() {
  const isActiveSelected = activeProfileId === selectedId && selectedId !== null;
  const running = state !== 'stopped' && state !== 'error';
  btnStart.textContent = running && isActiveSelected ? 'Stop' : 'Start';
}

function renderList() {
  profileList.textContent = '';
  for (const p of profiles) {
    const li = document.createElement('li');
    li.className = 'profile-item' + (p.id === selectedId ? ' selected' : '');
    li.dataset.id = p.id;

    const dot = document.createElement('span');
    dot.className = 'profile-dot';
    if (p.id === activeProfileId) {
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
  if (id === selectedId) return;
  if (dirty) {
    if (!window.confirm('Discard unsaved changes to the current profile?')) return;
  }
  selectedId = id;
  await loadProfile(id);
  renderList();
}

function startRename(id) {
  const item = profileList.querySelector('li[data-id="' + id + '"]');
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
      const res = await api.profiles.rename(id, value);
      if (!res.ok) appendLog('[gui] Rename failed: ' + res.error);
      else {
        const p = profiles.find((x) => x.id === id);
        if (p) p.name = value;
      }
    }
    renderList();
    refreshDefaultSelect();
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
  const running = activeProfileId === id && state !== 'stopped' && state !== 'error';
  const msg = running
    ? 'Profile "' + name + '" is currently running. Stop it and delete the profile?'
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
  if (!profiles.some((x) => x.id === selectedId)) {
    selectedId = profiles.length ? profiles[0].id : null;
    if (selectedId) await loadProfile(selectedId);
  }
  renderList();
  refreshDefaultSelect();
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

async function validateProfile() {
  if (!selectedId) return;
  appendLog('[gui] Validating config...');
  const res = await api.profiles.validate(selectedId, editor.value);
  appendLog(res.ok ? '[gui] Config OK' : '[gui] Validation failed:\n' + res.output);
}

async function startStop() {
  if (!selectedId) return;
  const running = state !== 'stopped' && state !== 'error';
  if (running && activeProfileId === selectedId) {
    await api.vpn.stop();
    return;
  }
  btnStart.disabled = true;
  const res = await api.vpn.start({ id: selectedId, text: editor.value, silent: silentCb.checked });
  btnStart.disabled = false;
  if (res.ok) {
    dirty = false;
    updateDirtyUI();
  } else if (res.output !== 'Already running') {
    appendLog('[gui] Start failed: ' + res.output);
    setStatus('error');
  }
}

function setStatus(nextState) {
  state = nextState;
  statusDot.className = 'dot ' + state;
  let label = STATE_LABEL[state] || state;
  const activeName = getProfileName(activeProfileId);
  if (activeName && state !== 'stopped' && state !== 'error') {
    label += ' \u2014 ' + activeName;
  }
  statusText.textContent = label;
  renderList();
}

function renderDefaultSelect() {
  const current = defaultProfileId;
  selectDefaultProfile.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Default: none';
  selectDefaultProfile.appendChild(none);
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    selectDefaultProfile.appendChild(opt);
  }
  selectDefaultProfile.value = current || '';
  const hasDefault = !!selectDefaultProfile.value;
  chkAutoconnect.disabled = !hasDefault;
  if (!hasDefault) chkAutoconnect.checked = false;
}

function refreshDefaultSelect() {
  if (defaultProfileId && !profiles.some((p) => p.id === defaultProfileId)) {
    defaultProfileId = null;
    chkAutoconnect.checked = false;
    api.settings.setDefaultProfile(null);
  }
  renderDefaultSelect();
}

btnNewProfile.addEventListener('click', async () => {
  if (dirty) {
    if (!window.confirm('Discard unsaved changes and create a new profile?')) return;
  }
  const res = await api.profiles.create();
  if (!res.ok) {
    appendLog('[gui] Failed to create profile: ' + res.error);
    return;
  }
  profiles.push({ id: res.profile.id, name: res.profile.name });
  selectedId = res.profile.id;
  dirty = false;
  updateDirtyUI();
  await loadProfile(res.profile.id);
  renderList();
  refreshDefaultSelect();
  appendLog('[gui] Created ' + res.profile.name);
});

btnSave.addEventListener('click', saveProfile);
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
  if (chkAutoconnect.checked && !defaultProfileId) {
    chkAutoconnect.checked = false;
    appendLog('[gui] Select a default profile first');
    return;
  }
  const res = await api.settings.setAutoconnect(chkAutoconnect.checked);
  if (!res.ok) {
    chkAutoconnect.checked = !chkAutoconnect.checked;
    appendLog('[gui] ' + res.error);
  }
});

selectDefaultProfile.addEventListener('change', async () => {
  const id = selectDefaultProfile.value || null;
  if (id === defaultProfileId) return;
  const res = await api.settings.setDefaultProfile(id);
  if (res.ok) {
    defaultProfileId = id;
    if (!id) chkAutoconnect.checked = false;
    chkAutoconnect.disabled = !id;
  } else {
    appendLog('[gui] ' + res.error);
    renderDefaultSelect();
  }
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
    saveProfile();
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
    startRename(e.target.closest('li.profile-item').dataset.id);
  }
});

api.onEvent('vpn:status', ({ state: nextState, activeProfileId: aid }) => {
  activeProfileId = aid;
  setStatus(nextState);
});

api.onEvent('vpn:log', ({ line }) => appendLog(line));

api.onEvent('vpn:readyz', ({ status, body }) => {
  appendLog('[readyz] HTTP ' + status + ' ' + body);
});

api.onEvent('vpn:metrics', ({ text }) => {
  metricsPane.textContent = text;
});

(async () => {
  const listRes = await api.profiles.list();
  if (listRes.ok) {
    profiles = listRes.profiles;
    const setRes = await api.settings.get();
    if (setRes.ok) {
      defaultProfileId = setRes.defaultProfileId || null;
      chkAutostart.checked = !!setRes.autostart;
      chkAutoconnect.checked = !!setRes.autoconnect;
    }
    refreshDefaultSelect();
  }
  if (!profiles.length) {
    const created = await api.profiles.create();
    if (created.ok) profiles = [{ id: created.profile.id, name: created.profile.name }];
  }
  selectedId = profiles.length ? profiles[0].id : null;
  if (selectedId) await loadProfile(selectedId);
  refreshDefaultSelect();

  const st = await api.vpn.state();
  activeProfileId = st.activeProfileId;
  setStatus(st.state);
})();