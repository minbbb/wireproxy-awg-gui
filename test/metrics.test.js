const { test } = require('node:test');
const assert = require('node:assert');
const { formatBytes, formatHandshake, summarizeMetrics } = require('../core/metrics');

const NOW = Math.floor(Date.now() / 1000);
const DUMP = `private_key=abc
listen_port=51820

public_key=peer1
endpoint=1.2.3.4:51820
tx_bytes=2048
rx_bytes=4096
last_handshake_time_sec=${NOW}
`;

test('formatBytes', () => {
  assert.strictEqual(formatBytes(500), '500 B');
  assert.strictEqual(formatBytes(2048), '2.00 KiB');
  assert.strictEqual(formatBytes(1048576), '1.00 MiB');
  assert.strictEqual(formatBytes('n/a'), 'n/a');
});

test('formatHandshake', () => {
  assert.strictEqual(formatHandshake(0), 'never');
  assert.strictEqual(formatHandshake(-5), 'never');
  assert.strictEqual(formatHandshake('nan'), 'never');
  assert.strictEqual(formatHandshake(NOW + 1), 'just now');
  assert.strictEqual(formatHandshake(NOW - 60), '1m 0s ago');
});

test('summarizeMetrics single peer', () => {
  const out = summarizeMetrics(DUMP);
  assert.match(out, /^listen_port = 51820/);
  assert.match(out, /endpoint = 1\.2\.3\.4:51820/);
  assert.match(out, /tx = 2\.00 KiB/);
  assert.match(out, /rx = 4\.00 KiB/);
});

test('summarizeMetrics multiple peers labels them', () => {
  const multi = DUMP + '\npublic_key=peer2\nendpoint=5.6.7.8:999\n';
  const out = summarizeMetrics(multi);
  assert.match(out, /Peer 1/);
  assert.match(out, /Peer 2/);
  assert.match(out, /5\.6\.7\.8:999/);
});

test('summarizeMetrics empty input', () => {
  assert.strictEqual(summarizeMetrics(''), '');
});