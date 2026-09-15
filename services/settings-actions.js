// Single source of truth for the settings setters shared by the IPC handlers
// and the tray menu callbacks. No Electron imports; app/autostart/targets are
// injected. `onSync` is a callback (e.g. tray sync) invoked after each change.

function createSettingsActions({ app, settings, targets, autostart, onSync }) {
  // Throws on failure (original autostart applies the OS login item, then saves).
  function setAutostart(enabled) {
    const on = !!enabled;
    autostart.applyAutostart(app, on);
    settings.save({ autostart: on });
    onSync();
  }

  function setAutoconnect(enabled) {
    const on = !!enabled;
    if (on && !targets.defaultTarget()) {
      return { ok: false, error: 'Set a default target first' };
    }
    settings.save({ autoconnect: on });
    onSync();
    return { ok: true };
  }

  function setDefaultTarget(kind, id) {
    const cleanKind = kind === 'chain' ? 'chain' : 'profile';
    if (id && !targets.targetExists(cleanKind, id)) {
      return { ok: false, error: 'Target not found' };
    }
    settings.save({
      defaultTarget: id ? { kind: cleanKind, id } : null,
      autoconnect: id ? settings.get().autoconnect : false,
    });
    onSync();
    return { ok: true };
  }

  // Clears the default target when the given predicate matches the current one
  // (used after deleting a profile/chain). Returns true if it was cleared.
  function clearTargetIf(matches) {
    const target = targets.defaultTarget();
    if (target && matches(target)) {
      settings.save({ defaultTarget: null, autoconnect: false });
      onSync();
      return true;
    }
    return false;
  }

  return {
    setAutostart,
    setAutoconnect,
    setDefaultTarget,
    clearTargetIf,
  };
}

module.exports = { createSettingsActions };