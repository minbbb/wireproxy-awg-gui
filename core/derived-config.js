// Pure Node builder for chain-hop derived configs. No Electron imports.

const DERIVED_CONF_DIRNAME = 'chain-run';
const SKIPPED_ROUTINE_SECTIONS = [
  'http',
  'tcpclienttunnel',
  'tcpservertunnel',
  'stdiotunnel',
  'udpproxytunnel',
];

// Builds a chain-hop config: rewritten peer endpoint (when relayPort), deterministic
// Socks5 port (when socksPort; null preserves the original Socks5 section as-is).
// A chain-level bindAddress overrides the exit hop's [Socks5] BindAddress (injected
// when the section is missing). Inner hops keep only the sections a hop needs (extra
// routine sections are dropped to avoid port clashes); the exit hop (keepRoutines)
// keeps its full config — incl. [http]/tunnels/auth — so chaining preserves the
// user's exit setup.
function buildDerivedConf(text, opts) {
  const out = [];
  let currentSection = null;
  let skipSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sec = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (sec) {
      currentSection = sec[1].toLowerCase();
      skipSection = !opts.keepRoutines && SKIPPED_ROUTINE_SECTIONS.includes(currentSection);
      if (!skipSection) out.push(line);
      continue;
    }
    if (skipSection) continue;
    if (currentSection === 'peer') {
      const m = /^Endpoint\s*=\s*(.*)$/i.exec(trimmed);
      if (m && opts.relayPort) {
        out.push('Endpoint = 127.0.0.1:' + opts.relayPort);
        continue;
      }
      out.push(line);
      continue;
    }
    if (currentSection === 'socks5') {
      if (/^BindAddress\s*=/.test(trimmed)) {
        if (opts.socksPort != null) {
          out.push('BindAddress = 127.0.0.1:' + opts.socksPort);
        } else if (opts.bindAddress) {
          out.push('BindAddress = ' + opts.bindAddress);
        } else {
          out.push(line);
        }
        continue;
      }
      if (/^(Username|Password)\s*=/.test(trimmed) && opts.socksPort != null) {
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  if ((opts.socksPort != null || opts.bindAddress) && !out.some((l) => /^\[Socks5\]\s*$/i.test(l))) {
    out.push('');
    out.push('[Socks5]');
    out.push('BindAddress = ' + (opts.socksPort != null ? '127.0.0.1:' + opts.socksPort : opts.bindAddress));
  }
  return out.join('\n');
}

module.exports = {
  DERIVED_CONF_DIRNAME,
  SKIPPED_ROUTINE_SECTIONS,
  buildDerivedConf,
};