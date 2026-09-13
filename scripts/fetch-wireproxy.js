'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const pkg = require('../package.json');
const CONF = pkg.config && pkg.config.wireproxy;
const BIN_DIR = path.join(__dirname, '..', 'bin');
const EXE_PATH = path.join(BIN_DIR, 'wireproxy.exe');

if (!CONF || !CONF.repo || !CONF.version || !CONF.asset) {
  console.error('Missing config.wireproxy in package.json (repo, version, asset are required).');
  process.exit(1);
}

const URL =
  'https://github.com/' +
  CONF.repo +
  '/releases/download/' +
  CONF.version +
  '/' +
  CONF.asset;

function log(msg) {
  console.log('[fetch-wireproxy] ' + msg);
}

function fail(msg) {
  console.error('[fetch-wireproxy] ERROR: ' + msg);
  process.exit(1);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'wireproxy-awg-gui-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(download(res.headers.location, dest));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function extractTarGz(tarball, destDir) {
  const res = spawnSync('tar', ['-xzf', tarball, '-C', destDir], { stdio: 'pipe' });
  if (res.status !== 0) {
    const msg = (res.stderr || '').toString().trim() || 'tar exited with status ' + res.status;
    throw new Error(msg);
  }
}

function findExe(dir) {
  const walk = (d) => {
    if (!fs.existsSync(d)) return null;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (/^wireproxy\.exe$/i.test(entry.name)) {
        return full;
      }
    }
    return null;
  };
  return walk(dir);
}

function verifyVersion(exe) {
  const res = spawnSync(exe, ['-v'], { encoding: 'utf8', windowsHide: true });
  const out = (res.stdout || '').trim() || (res.stderr || '').trim();
  if (res.status !== 0) throw new Error('wireproxy -v failed (' + res.status + '): ' + out);
  log('binary reports: ' + out);
  if (out.indexOf('wireproxy, version ') !== -1) {
    const ver = out.split('version ')[1].trim();
    const expected = CONF.version.replace(/^v/, '');
    if (ver !== expected) {
      throw new Error('expected version ' + expected + ', got ' + ver);
    }
  }
}

const NO_SKIP = process.argv.includes('--no-skip');

(async () => {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  if (!NO_SKIP && fs.existsSync(EXE_PATH)) {
    try {
      verifyVersion(EXE_PATH);
      log('already up to date, skipping (use -- --no-skip to re-download)');
      return;
    } catch (_) {
      log('existing binary version mismatch, re-downloading');
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wireproxy-dl-'));
  try {
    const tarball = path.join(tmpRoot, CONF.asset);
    const extractDir = path.join(tmpRoot, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });

    log('downloading ' + URL);
    await download(URL, tarball);

    if (CONF.sha256) {
      const actual = sha256File(tarball);
      if (actual !== CONF.sha256) {
        fail('sha256 mismatch for ' + CONF.asset + '\n  expected: ' + CONF.sha256 + '\n  actual:   ' + actual);
      }
    }

    log('extracting ' + CONF.asset);
    extractTarGz(tarball, extractDir);
    const found = findExe(extractDir);
    if (!found) fail('wireproxy.exe not found inside ' + CONF.asset);

    if (fs.existsSync(EXE_PATH)) fs.unlinkSync(EXE_PATH);
    fs.copyFileSync(found, EXE_PATH);
    log('installed ' + EXE_PATH);

    verifyVersion(EXE_PATH);
    log('done');
  } catch (e) {
    fail(e.message);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})();