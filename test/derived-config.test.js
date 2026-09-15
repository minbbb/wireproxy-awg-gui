const { test } = require('node:test');
const assert = require('node:assert');
const { buildDerivedConf, SKIPPED_ROUTINE_SECTIONS } = require('../core/derived-config');

const INNER = `[Interface]
PrivateKey = abc
Address = 10.0.0.2/32

[Peer]
PublicKey = xyz
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0

[Socks5]
BindAddress = 127.0.0.1:25344
Username = bob
Password = secret

[http]
BindAddress = 127.0.0.1:8080
`;

test('inner hop: rewrites endpoint, deterministic socks, strips routines+auth', () => {
  const out = buildDerivedConf(INNER, {
    socksPort: 40000,
    relayPort: 40001,
    keepRoutines: false,
    bindAddress: null,
  });
  assert.match(out, /Endpoint = 127\.0\.0\.1:40001/);
  assert.match(out, /BindAddress = 127\.0\.0\.1:40000/);
  assert.doesNotMatch(out, /^Username\s*=/m);
  assert.doesNotMatch(out, /^Password\s*=/m);
  assert.doesNotMatch(out, /^\[http\]/m);
  assert.doesNotMatch(out, /tcpclienttunnel|stdiotunnel|udpproxytunnel/);
});

test('exit hop: keeps routines and original bind when no override', () => {
  const out = buildDerivedConf(INNER, {
    socksPort: null,
    relayPort: null,
    keepRoutines: true,
    bindAddress: null,
  });
  assert.match(out, /^\[http\]/m);
  assert.match(out, /BindAddress = 127\.0\.0\.1:25344/);
  assert.match(out, /Endpoint = vpn\.example\.com:51820/);
});

test('exit hop: chain bindAddress overrides Socks5 bind', () => {
  const out = buildDerivedConf(INNER, {
    socksPort: null,
    relayPort: null,
    keepRoutines: true,
    bindAddress: '127.0.0.1:31000',
  });
  assert.match(out, /BindAddress = 127\.0\.0\.1:31000/);
});

test('no Socks5 section: injected', () => {
  const out = buildDerivedConf('[Peer]\nEndpoint = a.com:1\n', {
    socksPort: 41000,
    relayPort: null,
    keepRoutines: false,
    bindAddress: null,
  });
  assert.match(out, /\[Socks5\]/);
  assert.match(out, /BindAddress = 127\.0\.0\.1:41000/);
});

test('SKIPPED_ROUTINE_SECTIONS contains the tunnel/http section names', () => {
  assert.ok(SKIPPED_ROUTINE_SECTIONS.includes('http'));
  assert.ok(SKIPPED_ROUTINE_SECTIONS.includes('udpproxytunnel'));
});