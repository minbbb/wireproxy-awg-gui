'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let baseDir = null;

function init(userDataPath) {
  baseDir = userDataPath;
}

function chainsFilePath() {
  if (!baseDir) throw new Error('chains.init() not called');
  return path.join(baseDir, 'chains.json');
}

function readChains() {
  try {
    const data = JSON.parse(fs.readFileSync(chainsFilePath(), 'utf8'));
    return Array.isArray(data.chains) ? data.chains : [];
  } catch {
    return [];
  }
}

function writeChains(chains) {
  const tmp = chainsFilePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ chains }, null, 2), 'utf8');
  fs.renameSync(tmp, chainsFilePath());
}

function nextName() {
  let max = 0;
  for (const c of readChains()) {
    const m = /^Chain (\d+)$/i.exec(c.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'Chain ' + (max + 1);
}

function list() {
  const chains = readChains();
  chains.sort((a, b) => a.created - b.created);
  return chains.map((c) => ({ id: c.id, name: c.name, profileIds: [...c.profileIds] }));
}

function get(id) {
  const chain = readChains().find((c) => c.id === id);
  if (!chain) return null;
  return {
    id: chain.id,
    name: chain.name,
    profileIds: [...chain.profileIds],
    created: chain.created,
  };
}

function create() {
  const chains = readChains();
  const id = crypto.randomUUID();
  const name = nextName();
  chains.push({ id, name, profileIds: [], created: Date.now() });
  writeChains(chains);
  return { id, name };
}

function save(id, name, profileIds) {
  const chains = readChains();
  const chain = chains.find((c) => c.id === id);
  if (!chain) throw new Error('Chain not found');
  const trimmed = (name || '').trim();
  if (trimmed) chain.name = trimmed;
  chain.profileIds = Array.isArray(profileIds)
    ? profileIds.filter((x, i) => x && profileIds.indexOf(x) === i)
    : [];
  writeChains(chains);
}

function rename(id, name) {
  const chains = readChains();
  const chain = chains.find((c) => c.id === id);
  if (!chain) throw new Error('Chain not found');
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Name cannot be empty');
  chain.name = trimmed;
  writeChains(chains);
}

function remove(id) {
  const chains = readChains();
  const idx = chains.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('Chain not found');
  chains.splice(idx, 1);
  writeChains(chains);
}

function pruneDeletedProfiles(profileIds) {
  const keep = new Set(profileIds);
  const chains = readChains();
  let changed = false;
  for (const c of chains) {
    const before = c.profileIds.length;
    c.profileIds = c.profileIds.filter((id) => keep.has(id));
    if (c.profileIds.length !== before) changed = true;
  }
  if (changed) writeChains(chains);
}

module.exports = {
  init,
  list,
  get,
  create,
  save,
  rename,
  remove,
  pruneDeletedProfiles,
};