const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

describe('diff service', () => {
  const fixturesDir = path.join(__dirname, '../../../__fixtures__');

  it('produces a patch that bspatch can apply back to the new buffer', async () => {
    const oldBuf = await fs.readFile(path.join(fixturesDir, 'old.bin'));
    const newBuf = await fs.readFile(path.join(fixturesDir, 'new.bin'));

    const diffService = require('./diff');
    const patchBuf = await diffService.computePatch(oldBuf, newBuf);

    expect(patchBuf).toBeInstanceOf(Buffer);
    expect(patchBuf.length).toBeGreaterThan(0);
    expect(patchBuf.length).toBeLessThan(newBuf.length);

    const tmp = `/tmp/diff-test-${Date.now()}`;
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(`${tmp}/old`, oldBuf);
    await fs.writeFile(`${tmp}/patch`, patchBuf);
    await new Promise((resolve, reject) => {
      const p = spawn('bspatch', [`${tmp}/old`, `${tmp}/new-out`, `${tmp}/patch`]);
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d));
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    });
    const reconstructed = await fs.readFile(`${tmp}/new-out`);
    expect(reconstructed.equals(newBuf)).toBe(true);
    await fs.rm(tmp, { recursive: true });
  });
});
