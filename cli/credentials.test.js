const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let credentials;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-creds-'));
  process.env.HOME = tmpHome;
  jest.resetModules();
  credentials = require('./credentials');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.HOME;
});

describe('credentials', () => {
  it('write + read round-trips JSON to ~/.config/ota-updates/credentials.json', () => {
    credentials.write({ serverUrl: 'https://x', token: 'ota_sess_abc', email: 'a@b', expiresAt: 'date' });
    const got = credentials.read();
    expect(got.token).toBe('ota_sess_abc');
    expect(got.email).toBe('a@b');
    const filePath = path.join(tmpHome, '.config', 'ota-updates', 'credentials.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const stat = fs.statSync(filePath);
    expect((stat.mode & 0o777).toString(8)).toBe('600');
  });

  it('read returns null when no credentials file exists', () => {
    expect(credentials.read()).toBeNull();
  });

  it('clear removes the file', () => {
    credentials.write({ serverUrl: 'https://x', token: 't', email: 'e', expiresAt: 'd' });
    credentials.clear();
    expect(credentials.read()).toBeNull();
  });
});
