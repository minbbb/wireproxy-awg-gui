// Pure Node process/network utilities used by the VPN engine. No Electron imports.

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function removeFile(p) {
  try {
    fs.unlinkSync(p);
  } catch {}
}

// Factory so a caller can bind a concrete wireproxy binary path. Returns
// (configPath) => Promise<{ code, stdout, stderr }>.
function createConfigTester(wireproxyPath) {
  return function runConfigTest(configPath) {
    return new Promise((resolve) => {
      const proc = spawn(wireproxyPath, ['-n', '-c', configPath], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    });
  };
}

function httpGet(httpPath, port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: httpPath, timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: body.trim() }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

module.exports = {
  getFreePort,
  removeFile,
  createConfigTester,
  httpGet,
};