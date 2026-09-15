// Pure Node INI helpers for wireproxy configs. No Electron imports.

function parseEndpoint(raw) {
  const m = (raw || '').trim().match(/^(.+):(\d+)$/);
  if (!m) return null;
  let host = m[1];
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, port: parseInt(m[2], 10) };
}

function findPeerEndpoint(text) {
  let inPeer = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const sec = /^\[([^\]]+)\]\s*$/.exec(t);
    if (sec) {
      inPeer = sec[1].toLowerCase() === 'peer';
      continue;
    }
    if (inPeer) {
      const m = /^Endpoint\s*=\s*(.+)$/i.exec(t);
      if (m) return parseEndpoint(m[1]);
    }
  }
  return null;
}

function parseSocksAddr(text) {
  let inSocks = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const sec = /^\[([^\]]+)\]\s*$/.exec(t);
    if (sec) {
      inSocks = sec[1].toLowerCase() === 'socks5';
      continue;
    }
    if (inSocks) {
      const m = /^BindAddress\s*=\s*([^\s#]+)/i.exec(t);
      if (m) return m[1];
    }
  }
  return null;
}

function parseSocksPort(text) {
  const addr = parseSocksAddr(text);
  if (addr) {
    const parsed = parseEndpoint(addr);
    if (parsed) return parsed.port;
  }
  return null;
}

// Counts [Peer] Endpoint lines. Hops past the first one must have exactly one:
// a second endpoint would be dialed directly, bypassing the chain.
function countPeerEndpoints(text) {
  let inPeer = false;
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const sec = /^\[([^\]]+)\]\s*$/.exec(t);
    if (sec) {
      inPeer = sec[1].toLowerCase() === 'peer';
      continue;
    }
    if (inPeer && /^Endpoint\s*=\s*.+$/i.test(t)) count++;
  }
  return count;
}

module.exports = {
  parseEndpoint,
  findPeerEndpoint,
  parseSocksAddr,
  parseSocksPort,
  countPeerEndpoints,
};