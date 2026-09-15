'use strict';

const net = require('net');
const dgram = require('dgram');

const ATYP_IPV4 = 0x01;
const ATYP_FQDN = 0x03;
const ATYP_IPV6 = 0x04;

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function formatIPv6(bytes) {
  const words = [];
  for (let i = 0; i < 8; i++) words.push(bytes.readUInt16BE(i * 2).toString(16));
  const colonized = words.join(':');
  return colonized.replace(/(^|:)(0(:|$)){2,}/, '::').replace(/^0+:/, ':').replace(/::0+$/, '::').replace(/^(:)+/, '::');
}

function ipv6ToBytes(host) {
  const bytes = Buffer.alloc(16);
  const sections = host.split('::');
  const left = sections[0] ? sections[0].split(':').filter(Boolean) : [];
  const right = sections[1] ? sections[1].split(':').filter(Boolean) : [];
  const zeros = 8 - (left.length + right.length);
  if (zeros < 1 && sections.length > 1) throw new Error('invalid IPv6 address: ' + host);
  let idx = 0;
  for (const p of left) {
    bytes.writeUInt16BE(parseInt(p || '0', 16) & 0xffff, idx);
    idx += 2;
  }
  idx += zeros * 2;
  for (const p of right) {
    bytes.writeUInt16BE(parseInt(p || '0', 16) & 0xffff, idx);
    idx += 2;
  }
  return bytes;
}

function encodeAddr(host, port) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port & 0xffff, 0);
  if (IPV4_RE.test(host)) {
    return Buffer.concat([
      Buffer.from([ATYP_IPV4, ...host.split('.').map((n) => parseInt(n, 10))]),
      portBuf,
    ]);
  }
  if (host.includes(':')) {
    return Buffer.concat([Buffer.from([ATYP_IPV6]), ipv6ToBytes(host), portBuf]);
  }
  const name = Buffer.from(host, 'utf8');
  return Buffer.concat([Buffer.from([ATYP_FQDN, name.length]), name, portBuf]);
}

function parseAddr(buf, atyp) {
  if (atyp === ATYP_IPV4) {
    if (buf.length < 6) return null;
    return { host: buf.slice(0, 4).join('.'), port: buf.readUInt16BE(4), offset: 6 };
  }
  if (atyp === ATYP_IPV6) {
    if (buf.length < 18) return null;
    return { host: formatIPv6(buf.slice(0, 16)), port: buf.readUInt16BE(16), offset: 18 };
  }
  if (atyp === ATYP_FQDN) {
    const len = buf[0];
    if (buf.length < 3 + len) return null;
    return {
      host: buf.slice(1, 1 + len).toString('utf8'),
      port: buf.readUInt16BE(1 + len),
      offset: 3 + len,
    };
  }
  return null;
}

function wrapDatagram(payload, host, port) {
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), encodeAddr(host, port), payload]);
}

function parseDatagram(buf) {
  if (buf.length < 4) return null;
  if (buf[2] !== 0) return null;
  const parsed = parseAddr(buf.slice(4), buf[3]);
  if (!parsed) return null;
  return { host: parsed.host, port: parsed.port, payload: buf.slice(4 + parsed.offset) };
}

const pendingBuffers = new WeakMap();

function readBytes(stream, n) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) {
      reject(new Error('connection closed'));
      return;
    }
    const queue = pendingBuffers.get(stream) || [];
    pendingBuffers.set(stream, queue);
    const chunks = [];
    let total = 0;
    const drain = () => {
      while (queue.length > 0 && total < n) {
        const c = queue[0];
        const take = Math.min(c.length, n - total);
        chunks.push(c.slice(0, take));
        total += take;
        if (c.length > take) {
          queue[0] = c.slice(take);
        } else {
          queue.shift();
        }
      }
      if (total >= n) {
        cleanup();
        resolve(Buffer.concat(chunks, n));
      }
    };
    const onData = (b) => {
      if (b.length > 0) queue.push(b);
      drain();
    };
    const onEnd = () => { cleanup(); reject(new Error('connection closed')); };
    const onError = (e) => { cleanup(); reject(e); };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    if (queue.length > 0) drain();
  });
}

async function parseReplyBody(stream, atyp) {
  if (atyp === ATYP_IPV4) {
    const buf = await readBytes(stream, 6);
    return { host: buf.slice(0, 4).join('.'), port: buf.readUInt16BE(4) };
  }
  if (atyp === ATYP_IPV6) {
    const buf = await readBytes(stream, 18);
    return { host: formatIPv6(buf.slice(0, 16)), port: buf.readUInt16BE(16) };
  }
  if (atyp === ATYP_FQDN) {
    const lenBuf = await readBytes(stream, 1);
    const len = lenBuf[0];
    const buf = await readBytes(stream, len + 2);
    return { host: buf.slice(0, len).toString('utf8'), port: buf.readUInt16BE(len) };
  }
  throw new Error('bad ATYP in SOCKS5 reply: ' + atyp);
}

class UdpOverSocksRelay {
  constructor(options) {
    this.socksHost = options.socksHost || '127.0.0.1';
    this.socksPort = options.socksPort;
    this.target = options.target; // { host, port } — real upstream peer endpoint
    this.listenPort = options.listenPort;
    this.debugLog = options.debugLog || (() => {});
    this.socket = null;
    this.control = null;
    this.relayAddr = null;
    this.peer = null;
    this.stopped = false;
    this.reconnectTimer = null;
  }

  async start() {
    this.stopped = false;
    this.peer = null;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => {
      if (this.relayAddr && rinfo.port === this.relayAddr.port) {
        this.relayResponse(msg, rinfo);
      } else {
        this.onSocketMessage(msg, rinfo);
      }
    });
    this.socket.on('error', (e) => {
      if (this.stopped) return;
      this.debugLog('relay socket error: ' + e.message);
    });
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.listenPort, '127.0.0.1', () => {
        this.socket.removeListener('error', reject);
        resolve();
      });
    });
    try {
      await this.connect();
    } catch (e) {
      this.debugLog('initial connect failed: ' + e.message);
      this.scheduleReconnect('initial connect failed');
    }
    this.debugLog('UDP relay listening on 127.0.0.1:' + this.listenPort);
  }

  async connect() {
    if (this.stopped) return;
    this.closeControl();
    this.relayAddr = null;
    const control = net.connect({ host: this.socksHost, port: this.socksPort });
    control.setNoDelay(true);
    // Swallow socket errors: connect/handshake failures surface via the
    // 'connect'/readBytes rejections below, but an error between stages (on a
    // socket readBytes already cleaned up from) must not crash the main
    // process with an unhandled 'error' event.
    control.on('error', () => {});
    await new Promise((resolve, reject) => {
      const onError = (e) => { cleanup(); reject(e); };
      const cleanup = () => { control.removeListener('error', onError); control.removeListener('connect', resolve); };
      control.once('error', onError);
      control.once('connect', () => { cleanup(); resolve(); });
    });

    // No-auth handshake
    control.write(Buffer.from([0x05, 0x01, 0x00]));
    const method = await readBytes(control, 2);
    if (method[0] !== 0x05 || method[1] !== 0x00) {
      throw new Error('SOCKS5 auth rejected (method 0x' + method[1].toString(16) + ')');
    }

    // UDP ASSOCIATE
    control.write(Buffer.concat([Buffer.from([0x05, 0x03, 0x00]), encodeAddr('0.0.0.0', 0)]));
    const base = await readBytes(control, 4);
    if (base[0] !== 0x05 || base[1] !== 0x00) {
      throw new Error('SOCKS5 UDP ASSOCIATE rejected (rep 0x' + base[1].toString(16) + ')');
    }
    const bnd = await parseReplyBody(control, base[3]);
    let address = bnd.host;
    if (address === '0.0.0.0' || address === '::') address = this.socksHost;

    this.control = control;
    this.relayAddr = { address, port: bnd.port };
    control.on('close', () => {
      if (this.control === control) this.control = null;
      if (!this.stopped) this.scheduleReconnect('control connection closed');
    });
    this.debugLog('SOCKS5 UDP ASSOCIATE via ' + this.socksHost + ':' + this.socksPort + ' => ' + address + ':' + bnd.port);
  }

  scheduleReconnect(reason) {
    if (this.stopped || this.reconnectTimer) return;
    this.debugLog('relay reconnecting in 2s (' + reason + ')');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connect().catch((e) => {
        this.debugLog('relay reconnect failed: ' + e.message + '; retrying in 2s');
        this.scheduleReconnect('reconnect failed');
      });
    }, 2000);
  }

  onSocketMessage(msg, rinfo) {
    if (this.stopped || !this.relayAddr) return;
    this.peer = { address: rinfo.address, port: rinfo.port };
    const wrapped = wrapDatagram(msg, this.target.host, this.target.port);
    this.socket.send(wrapped, this.relayAddr.port, this.relayAddr.address, (err) => {
      if (err && !this.stopped) this.debugLog('relay send failed: ' + err.message);
    });
  }

  relayResponse(msg, rinfo) {
    if (!this.peer || !this.relayAddr) return;
    if (rinfo.port !== this.relayAddr.port) return;
    const parsed = parseDatagram(msg);
    if (!parsed) return;
    this.socket.send(parsed.payload, this.peer.port, this.peer.address, (err) => {
      if (err && !this.stopped) this.debugLog('relay reply failed: ' + err.message);
    });
  }

  closeControl() {
    if (this.control) {
      this.control.removeAllListeners();
      this.control.destroy();
      this.control = null;
    }
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeControl();
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
  }
}

module.exports = { UdpOverSocksRelay };