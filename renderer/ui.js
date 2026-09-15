// DOM element refs, rendering and UI helpers. Depends on state.js (window.WGApp).
// Deliberately keeps NO business/CRUD logic; renderer.js wires actions.
(function () {
  const App = window.WGApp;
  const s = App.s;
  const $ = (id) => document.getElementById(id);

  App.el = {
    editor: $('editor'),
    chainEditor: $('chainEditor'),
    chainName: $('chainName'),
    chainBindAddress: $('chainBindAddress'),
    chainAddSelect: $('chainAddSelect'),
    btnChainAdd: $('btnChainAdd'),
    chainProfileList: $('chainProfileList'),
    chainEmpty: $('chainEmpty'),
    btnSave: $('btnSave'),
    btnValidate: $('btnValidate'),
    btnStart: $('btnStart'),
    btnClearLog: $('btnClearLog'),
    btnNewProfile: $('btnNewProfile'),
    btnNewChain: $('btnNewChain'),
    silentCb: $('silent'),
    logPane: $('logPane'),
    metricsPane: $('metricsPane'),
    statusDot: $('statusDot'),
    statusText: $('statusText'),
    proxyAddr: $('proxyAddr'),
    profileList: $('profileList'),
    chainList: $('chainList'),
    chkAutostart: $('chkAutostart'),
    chkAutoconnect: $('chkAutoconnect'),
    selectDefaultTarget: $('selectDefaultTarget'),
  };
  const el = App.el;

  function running() {
    return s.state !== 'stopped' && s.state !== 'error';
  }

  function parseProxyAddr(text) {
    const match = text.match(/\[(Socks5|http)\][\s\S]*?BindAddress\s*=\s*([^\r\n#]+)/i);
    el.proxyAddr.textContent = match ? (match[1] + ' at ' + match[2].trim()) : '';
  }

  function appendLog(line) {
    let text = line;
    if (el.logPane.textContent) text = '\n' + text;
    el.logPane.textContent += text;
    while (el.logPane.textContent.length > 100000) {
      el.logPane.textContent = el.logPane.textContent.slice(20000);
    }
    el.logPane.scrollTop = el.logPane.scrollHeight;
  }

  function updateDirtyUI() {
    const label = (s.mode === 'chain' ? s.chainDirty : s.dirty) ? 'Save* (Ctrl+S)' : 'Save (Ctrl+S)';
    el.btnSave.textContent = label;
  }

  function updateStartBtn() {
    let active = false;
    if (s.mode === 'profile') {
      active = s.selectedId !== null && s.activeIds.includes(s.selectedId);
    } else {
      active = s.selectedChainId !== null && s.chainId === s.selectedChainId;
    }
    el.btnStart.textContent = running() && active ? 'Stop' : 'Start';
    el.btnValidate.disabled = s.mode !== 'profile';
  }

  // renderLists redraws the sidebars; renderChainEditor is intentionally NOT called
  // here — rebuilding the editor on every 1s status poll would clobber the dropdowns
  // the user may be interacting with. It is only re-rendered on explicit actions.
  function renderLists() {
    renderItemList({
      container: el.profileList,
      items: s.profiles,
      isSelected: (p) => s.mode === 'profile' && p.id === s.selectedId,
      isActive: (p) => s.activeIds.includes(p.id) && running(),
      delTitle: 'Delete profile',
    });
    renderItemList({
      container: el.chainList,
      items: s.chains,
      isSelected: (c) => s.mode === 'chain' && c.id === s.selectedChainId,
      isActive: (c) => c.id === s.chainId && running(),
      delTitle: 'Delete chain',
    });
    updateStartBtn();
  }

  function renderListsAndDefault() {
    renderLists();
    renderDefaultSelect();
  }

  // Shared builder for the sidebar lists (profiles and chains share the same
  // markup/logic — was renderList + renderChainList, ~95% identical).
  function renderItemList({ container, items, isSelected, isActive, delTitle }) {
    container.textContent = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'profile-item' + (isSelected(item) ? ' selected' : '');
      li.dataset.id = item.id;

      const dot = document.createElement('span');
      dot.className = 'profile-dot';
      if (isActive(item)) {
        dot.classList.add(s.state);
      }

      const name = document.createElement('span');
      name.className = 'profile-name';
      name.textContent = item.name;
      name.title = item.name;

      const del = document.createElement('button');
      del.className = 'profile-del';
      del.textContent = '\u00d7';
      del.title = delTitle;

      li.appendChild(dot);
      li.appendChild(name);
      li.appendChild(del);
      container.appendChild(li);
    }
  }

  function renderChainEditor() {
    const chain = s.chains.find((x) => x.id === s.selectedChainId);
    el.chainProfileList.textContent = '';
    if (!chain) {
      el.chainEmpty.classList.add('hidden');
      return;
    }
    el.chainEmpty.classList.toggle('hidden', s.chainProfileIds.length > 0);
    el.chainAddSelect.innerHTML = '';
    for (const p of s.profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      opt.hidden = s.chainProfileIds.includes(p.id);
      el.chainAddSelect.appendChild(opt);
    }
    for (let i = 0; i < s.chainProfileIds.length; i++) {
      const pid = s.chainProfileIds[i];
      const li = document.createElement('li');
      li.className = 'chain-hop-item';

      const sel = document.createElement('select');
      for (const p of s.profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
      }
      sel.value = pid;
      sel.title = 'Hop ' + (i + 1) + (i === 0 ? ' (outermost)' : i === s.chainProfileIds.length - 1 ? ' (exit)' : '');
      sel.addEventListener('change', () => {
        const value = sel.value;
        for (let j = 0; j < s.chainProfileIds.length; j++) {
          if (j !== i && s.chainProfileIds[j] === value) {
            appendLog('[gui] Profile is already in this chain');
            sel.value = pid;
            return;
          }
        }
        s.chainProfileIds[i] = value;
        markChainDirty();
      });

      const up = document.createElement('button');
      up.textContent = '\u2191';
      up.title = 'Move hop up (closer to the outermost hop)';
      up.disabled = i === 0;
      up.addEventListener('click', () => moveHop(i, -1));

      const down = document.createElement('button');
      down.textContent = '\u2193';
      down.title = 'Move hop down';
      down.disabled = i === s.chainProfileIds.length - 1;
      down.addEventListener('click', () => moveHop(i, 1));

      const remove = document.createElement('button');
      remove.className = 'hop-btn-remove';
      remove.textContent = '\u00d7';
      remove.title = 'Remove hop';
      remove.addEventListener('click', () => {
        s.chainProfileIds.splice(i, 1);
        markChainDirty();
      });

      li.appendChild(sel);
      li.appendChild(up);
      li.appendChild(down);
      li.appendChild(remove);
      el.chainProfileList.appendChild(li);
    }
  }

  // The "…edited → set chainDirty → re-render editor → refresh save button"
  // sequence repeats after every hop mutation; collapsed into one helper.
  function markChainDirty() {
    s.chainDirty = true;
    renderChainEditor();
    updateDirtyUI();
  }

  function moveHop(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= s.chainProfileIds.length) return;
    const t = s.chainProfileIds[i];
    s.chainProfileIds[i] = s.chainProfileIds[j];
    s.chainProfileIds[j] = t;
    markChainDirty();
  }

  function setStatus(nextState) {
    s.state = nextState;
    el.statusDot.className = 'dot ' + nextState;
    let label = App.STATE_LABEL[nextState] || nextState;
    if (nextState !== 'stopped' && nextState !== 'error') {
      if (s.chainId) {
        const c = App.getChainName(s.chainId);
        if (c) label += ' \u2014 ' + c;
      } else {
        const n = App.getProfileName(s.activeProfileId);
        if (n) label += ' \u2014 ' + n;
      }
    }
    el.statusText.textContent = label;

    if (nextState === 'stopped' || nextState === 'error') {
      el.proxyAddr.textContent = '';
    }

    const key = App.statusKey();
    if (key !== s.lastStatusKey) {
      s.lastStatusKey = key;
      renderLists();
    } else {
      updateStartBtn();
    }
  }

  function renderDefaultSelect() {
    const current = s.defaultTarget;
    const currentValue = current ? (current.kind === 'chain' ? 'c:' : 'p:') + current.id : '';
    el.selectDefaultTarget.innerHTML = '';

    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Default: none';
    el.selectDefaultTarget.appendChild(none);

    for (const set of [
      { kind: 'profile', label: 'Profiles', items: s.profiles },
      { kind: 'chain', label: 'Chains', items: s.chains },
    ]) {
      const group = document.createElement('optgroup');
      group.label = set.label;
      for (const it of set.items) {
        const opt = document.createElement('option');
        opt.value = (set.kind === 'chain' ? 'c:' : 'p:') + it.id;
        opt.textContent = it.name;
        group.appendChild(opt);
      }
      el.selectDefaultTarget.appendChild(group);
    }

    el.selectDefaultTarget.value = currentValue;
    const hasDefault = !!el.selectDefaultTarget.value;
    el.chkAutoconnect.disabled = !hasDefault;
    if (!hasDefault) el.chkAutoconnect.checked = false;
  }

  // Inline rename for a sidebar item. Ids are found by iterating the DOM instead
  // of interpolating into a CSS selector (defensive against selector injection).
  function startRename(id, whichList, finishApi) {
    const list = whichList === 'profiles' ? el.profileList : el.chainList;
    let item = null;
    for (const li of list.querySelectorAll('li.profile-item')) {
      if (li.dataset.id === id) { item = li; break; }
    }
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
          const arr = whichList === 'profiles' ? s.profiles : s.chains;
          const item2 = arr.find((x) => x.id === id);
          if (item2) item2.name = value;
          if (whichList === 'chains' && s.mode === 'chain' && id === s.selectedChainId) {
            el.chainName.value = value;
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

  // Shared delegated click/dblclick wiring for both sidebars.
  function bindList(listEl, kind, opts) {
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('li.profile-item');
      if (!item) return;
      const id = item.dataset.id;
      if (e.target.classList.contains('profile-del')) {
        opts.onDelete(id);
        return;
      }
      opts.onSelect(id);
    });
    listEl.addEventListener('dblclick', (e) => {
      if (!e.target.classList.contains('profile-name')) return;
      const item = e.target.closest('li.profile-item');
      if (!item) return;
      startRename(item.dataset.id, kind, opts.renameApi);
    });
  }

  App.ui = {
    running,
    parseProxyAddr,
    appendLog,
    updateDirtyUI,
    updateStartBtn,
    renderLists,
    renderListsAndDefault,
    renderChainEditor,
    setStatus,
    renderDefaultSelect,
    startRename,
    bindList,
  };
})();