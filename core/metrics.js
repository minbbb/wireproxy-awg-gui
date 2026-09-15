// Pure Node wg /metrics formatting. No Electron imports.

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return String(n);
  if (v < 1024) return v + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let num = v;
  let i = -1;
  do {
    num /= 1024;
    i++;
  } while (num >= 1024 && i < units.length - 1);
  const str = num >= 100 ? num.toFixed(0) : num >= 10 ? num.toFixed(1) : num.toFixed(2);
  return str + ' ' + units[i];
}

function formatHandshake(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return 'never';
  const diff = Math.floor(Date.now() / 1000) - s;
  if (diff < 0) return 'just now';
  if (diff < 60) return diff + 's ago';
  const m = Math.floor(diff / 60);
  if (m < 60) return m + 'm ' + (diff % 60) + 's ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
}

// Turns the raw wg dump from /metrics (device block + one block per peer) into a
// compact summary. Kept: listen_port (device) and per-peer endpoint, tx, rx,
// last_handshake. toString() produces "set" format, so blocks are separated by
// blank lines; public_key is the first key of every peer block either way.
function summarizeMetrics(text) {
  const peers = [];
  const device = {};
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current) {
        peers.push(current);
        current = null;
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === 'public_key') {
      if (current) peers.push(current);
      current = { key: val };
      continue;
    }
    if (!current) {
      if (key === 'listen_port') device.listenPort = val;
      continue;
    }
    if (key === 'endpoint') current.endpoint = val;
    else if (key === 'tx_bytes') current.tx = val;
    else if (key === 'rx_bytes') current.rx = val;
    else if (key === 'last_handshake_time_sec') current.handshake = val;
  }
  if (current) peers.push(current);

  const out = [];
  if (device.listenPort) out.push('listen_port = ' + device.listenPort);
  const many = peers.length > 1;
  for (let i = 0; i < peers.length; i++) {
    const p = peers[i];
    const lines = [];
    if (p.endpoint) lines.push('endpoint = ' + p.endpoint);
    lines.push('last_handshake = ' + formatHandshake(p.handshake));
    lines.push('tx = ' + formatBytes(p.tx));
    lines.push('rx = ' + formatBytes(p.rx));
    if (lines.length === 0) continue;
    if (many) {
      out.push('Peer ' + (i + 1));
      for (const l of lines) out.push('  ' + l);
    } else {
      out.push(...lines);
    }
  }
  return out.join('\n');
}

module.exports = {
  formatBytes,
  formatHandshake,
  summarizeMetrics,
};