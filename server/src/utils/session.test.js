const session = require('./session');

describe('session util', () => {
  it('generateToken returns prefixed token + sha256 hash', () => {
    const { token, tokenHash } = session.generateToken();
    expect(token.startsWith('ota_sess_')).toBe(true);
    expect(token.length).toBeGreaterThan('ota_sess_'.length + 30);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashToken is deterministic and matches generateToken output', () => {
    const { token, tokenHash } = session.generateToken();
    expect(session.hashToken(token)).toBe(tokenHash);
  });

  it('successive generateToken calls return distinct tokens', () => {
    const a = session.generateToken();
    const b = session.generateToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
