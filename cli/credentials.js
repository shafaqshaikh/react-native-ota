const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configDir() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.config', 'ota-updates');
}

function configFile() {
  return path.join(configDir(), 'credentials.json');
}

function read() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(creds) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configFile();
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function clear() {
  try { fs.unlinkSync(configFile()); } catch {}
}

module.exports = { read, write, clear, configFile, configDir };
