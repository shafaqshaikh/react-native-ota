const password = require('./password');

describe('password util', () => {
  it('round-trips a plaintext through hash/compare', async () => {
    const hash = await password.hash('hunter2');
    expect(typeof hash).toBe('string');
    expect(hash).not.toBe('hunter2');
    expect(hash.startsWith('$2')).toBe(true);
    const ok = await password.compare('hunter2', hash);
    expect(ok).toBe(true);
  });

  it('rejects the wrong plaintext', async () => {
    const hash = await password.hash('hunter2');
    const ok = await password.compare('hunter3', hash);
    expect(ok).toBe(false);
  });

  it('uses 12 rounds', async () => {
    const hash = await password.hash('x');
    const rounds = parseInt(hash.split('$')[2], 10);
    expect(rounds).toBe(12);
  });
});
