const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG = `# wireproxy-awg configuration
# Fill in your keys and peer settings, then click Start.

[Interface]
PrivateKey =
Address = 10.0.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey =
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0

[Socks5]
BindAddress = 127.0.0.1:25344
`;

let baseDir = null;

function init(userDataPath) {
  baseDir = path.join(userDataPath, 'profiles');
  fs.mkdirSync(baseDir, { recursive: true });
  migrateLegacy(userDataPath);
}

function indexFilePath() {
  return path.join(baseDir, 'index.json');
}

function confPath(id) {
  return path.join(baseDir, id + '.conf');
}

function readIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(indexFilePath(), 'utf8'));
    return Array.isArray(data.profiles) ? data.profiles : [];
  } catch {
    return [];
  }
}

function writeIndex(profiles) {
  const tmp = indexFilePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ profiles }, null, 2), 'utf8');
  fs.renameSync(tmp, indexFilePath());
}

function writeConf(id, content) {
  const p = confPath(id);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
}

function migrateLegacy(userDataPath) {
  if (fs.existsSync(indexFilePath())) return;
  const legacy = path.join(userDataPath, 'wireproxy.conf');
  let content = DEFAULT_CONFIG;
  if (fs.existsSync(legacy)) {
    content = fs.readFileSync(legacy, 'utf8');
  }
  const id = crypto.randomUUID();
  writeConf(id, content);
  writeIndex([{ id, name: 'Profile 1', created: Date.now() }]);
}

function nextName() {
  let max = 0;
  for (const p of readIndex()) {
    const m = /^Profile (\d+)$/i.exec(p.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'Profile ' + (max + 1);
}

function list() {
  const profiles = readIndex();
  profiles.sort((a, b) => a.created - b.created);
  return profiles.map((p) => ({ id: p.id, name: p.name }));
}

function get(id) {
  const profile = readIndex().find((p) => p.id === id);
  if (!profile) return null;
  try {
    const content = fs.readFileSync(confPath(id), 'utf8');
    return { id: profile.id, name: profile.name, content };
  } catch {
    return null;
  }
}

function save(id, content) {
  const profiles = readIndex();
  if (!profiles.some((p) => p.id === id)) {
    throw new Error('Profile not found');
  }
  writeConf(id, content);
}

function create() {
  const id = crypto.randomUUID();
  const name = nextName();
  const profiles = readIndex();
  profiles.push({ id, name, created: Date.now() });
  writeIndex(profiles);
  writeConf(id, DEFAULT_CONFIG);
  return { id, name };
}

function rename(id, name) {
  const profiles = readIndex();
  const profile = profiles.find((p) => p.id === id);
  if (!profile) throw new Error('Profile not found');
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Name cannot be empty');
  profile.name = trimmed;
  writeIndex(profiles);
}

function remove(id) {
  const profiles = readIndex();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error('Profile not found');
  if (profiles.length <= 1) throw new Error('Cannot delete the last profile');
  profiles.splice(idx, 1);
  writeIndex(profiles);
  try {
    fs.unlinkSync(confPath(id));
  } catch {}
}

module.exports = {
  DEFAULT_CONFIG,
  init,
  list,
  get,
  save,
  create,
  rename,
  remove,
  confPath,
};