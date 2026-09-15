const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseEndpoint,
  findPeerEndpoint,
  parseSocksAddr,
  parseSocksPort,
  countPeerEndpoints,
} = require('../core/config-parser');

const SAMPLE = `[Interface]
PrivateKey = abc
Address = 10.0.0.2/32

[Peer]
PublicKey = xyz
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0

[Socks5]
BindAddress = 127.0.0.1:25344
`;

test('parseEndpoint', () => {
  assert.deepStrictEqual(parseEndpoint('host:123'), { host: 'host', port: 123 });
  assert.deepStrictEqual(parseEndpoint('[::1]:999'), { host: '::1', port: 999 });
  assert.strictEqual(parseEndpoint('no-port'), null);
  assert.strictEqual(parseEndpoint(''), null);
});

test('findPeerEndpoint', () => {
  assert.deepStrictEqual(findPeerEndpoint(SAMPLE), { host: 'vpn.example.com', port: 51820 });
  assert.strictEqual(findPeerEndpoint('[Interface]\nAddress = 10.0.0.2/32\n'), null);
  assert.deepStrictEqual(findPeerEndpoint('[peer]\nEndpoint = 1.2.3.4:51820\n'), { host: '1.2.3.4', port: 51820 });
});

test('parseSocksAddr / parseSocksPort', () => {
  assert.strictEqual(parseSocksAddr(SAMPLE), '127.0.0.1:25344');
  assert.strictEqual(parseSocksPort(SAMPLE), 25344);
  assert.strictEqual(parseSocksAddr('[Interface]\nDNS = 1.1.1.1\n'), null);
  assert.strictEqual(parseSocksPort('[Socks5]\nBindAddress = 127.0.0.1:999\n'), 999);
  assert.strictEqual(parseSocksPort('[Socks5]\nBindAddress = nope\n'), null);
});

test('countPeerEndpoints', () => {
  assert.strictEqual(countPeerEndpoints(SAMPLE), 1);
  assert.strictEqual(countPeerEndpoints('[Peer]\nEndpoint = a:1\n\n[Peer]\nEndpoint = b:2\n'), 2);
  assert.strictEqual(countPeerEndpoints('[Peer]\nPublicKey = x\n'), 0);
});