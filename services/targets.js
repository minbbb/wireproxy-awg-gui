// Default-target resolution and lookups shared by the tray, IPC handlers and
// autoconnect. Pure Node; dependency modules (settings/profiles/chains) are
// injected.

function createTargetService({ settings, profiles, chains }) {
  function defaultTarget() {
    const s = settings.get();
    if (s.defaultTarget && s.defaultTarget.id) {
      return { kind: s.defaultTarget.kind, id: s.defaultTarget.id };
    }
    if (s.defaultProfileId) {
      return { kind: 'profile', id: s.defaultProfileId };
    }
    return null;
  }

  function targetExists(kind, id) {
    if (kind === 'chain') return !!chains.get(id);
    return !!profiles.get(id);
  }

  function targetName(kind, id) {
    if (!id) return null;
    if (kind === 'chain') {
      const c = chains.get(id);
      return c ? c.name : null;
    }
    const p = profiles.get(id);
    return p ? p.name : null;
  }

  return {
    defaultTarget,
    targetExists,
    targetName,
  };
}

module.exports = { createTargetService };