'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const dgram = require('dgram');
const { UdpOverSocksRelay } = require('../core/relay');

function bindUdp() {
  const s = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.bind(0, '127.0.0.1', () => {
      s.removeListener('error', reject);
      resolve(s);
    });
  });
}

// Minimal SOCKS5 server: no-auth handshake + UDP ASSOCIATE bound to a UDP
// socket the test feeds/replies from.
function startMockSocks(udpRelay) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      let consumed = 0;
      let stage = 'greeting';
      socket.on('error', () => {});
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (stage === 'greeting' && buf.length - consumed >= 2) {
            stage = 'associate';
            socket.write(Buffer.from([0x05, 0x00]));
          } else if (stage === 'associate' && buf.length - consumed >= 10) {
            stage = 'done';
            consumed = buf.length;
            const port = udpRelay.address().port;
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, (port >> 8) & 0xff, port & 0xff]));
          } else {
            break;
          }
        }
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function recv(socket, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('recv timeout'));
    }, timeout);
    const onMessage = (msg) => {
      cleanup();
      resolve(msg);
    };
    const onError = (e) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      socket.removeListener('error', onError);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

test('UdpOverSocksRelay forwards UDP through SOCKS5 UDP ASSOCIATE', async () => {
  const udpRelay = await bindUdp();
  const mock = await startMockSocks(udpRelay);
  const target = await bindUdp(); // mock "upstream peer" socket
  let client = null;
  const relay = new UdpOverSocksRelay({
    socksHost: '127.0.0.1',
    socksPort: mock.port,
    target: { host: '10.9.8.7', port: 4321 },
    listenPort: 0,
    debugLog: () => {},
  });
  try {
    await relay.start();
    const relayPort = relay.socket.address().port;
    assert.ok(relay.relayAddr, 'relay should have a UDP ASSOCIATE address');
    assert.strictEqual(relay.relayAddr.address, '127.0.0.1');
    assert.strictEqual(relay.relayAddr.port, udpRelay.address().port);

    client = dgram.createSocket('udp4');
    client.on('error', () => {});

    // Forward: client -> relay -> SOCKS UDP relay (wrapped with target header).
    const gotForward = recv(udpRelay);
    client.send('hello', relayPort, '127.0.0.1');
    const wrapped = await gotForward;
    assert.deepStrictEqual(wrapped.slice(0, 3), Buffer.from([0x00, 0x00, 0x00]));
    assert.strictEqual(wrapped[3], 0x01, 'target must be IPv4');
    assert.strictEqual(wrapped.slice(4, 8).join('.'), '10.9.8.7');
    assert.strictEqual(wrapped.readUInt16BE(8), 4321);
    assert.strictEqual(wrapped.slice(10).toString(), 'hello');

    // Reply: SOCKS UDP relay -> relay (unwraps) -> original client.
    const gotReply = recv(client);
    const header = Buffer.from([0x00, 0x00, 0x00, 0x01, 1, 2, 3, 4]);
    const port = Buffer.alloc(2);
    port.writeUInt16BE(8888);
    udpRelay.send(Buffer.concat([header, port, Buffer.from('world')]), relayPort, '127.0.0.1');
    const reply = await gotReply;
    assert.strictEqual(reply.toString(), 'world');
  } finally {
    relay.stop();
    if (client) client.close();
    target.close();
    udpRelay.close();
    mock.server.close();
  }
});