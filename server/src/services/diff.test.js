const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
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

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-test-'));
    try {
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
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('diff.generate()', () => {
  const fixturesDir = path.join(__dirname, '../../../__fixtures__');

  it('uploads patch + inserts UpdateDiff doc when patch under 60% threshold', async () => {
    const oldBuf = await fs.readFile(path.join(fixturesDir, 'old.bin'));
    const newBuf = await fs.readFile(path.join(fixturesDir, 'new.bin'));

    const fakeS3 = {
      downloadBuffer: jest.fn().mockResolvedValue(oldBuf),
      uploadBuffer: jest.fn().mockResolvedValue(),
      publicUrl: jest.fn((k) => `https://r2.test/${k}`),
    };
    const fakeUpdateDiff = { create: jest.fn().mockResolvedValue({}) };

    const diffService = require('./diff');
    const result = await diffService.generate({
      baseUpdate: { _id: 'BASE', bundleKey: 'p/BASE/bundle.hbc', bundleHash: 'oldhash' },
      newUpdate: { _id: 'NEW' },
      newBundleBuffer: newBuf,
      projectSlug: 'p',
      s3: fakeS3,
      UpdateDiff: fakeUpdateDiff,
    });

    expect(result).not.toBeNull();
    expect(fakeS3.downloadBuffer).toHaveBeenCalledWith('p/BASE/bundle.hbc');
    expect(fakeS3.uploadBuffer).toHaveBeenCalledWith(
      'p/NEW/diffs/BASE.patch',
      expect.any(Buffer),
      'application/octet-stream',
    );
    expect(fakeUpdateDiff.create).toHaveBeenCalledWith(
      expect.objectContaining({
        toUpdateId: 'NEW',
        fromUpdateId: 'BASE',
        fromBundleHash: 'oldhash',
        patchKey: 'p/NEW/diffs/BASE.patch',
      }),
    );
  });

  it('returns null and skips upload when patch is too large (size guard)', async () => {
    // Use truly random buffers so bsdiff cannot compress and patch exceeds 60% threshold
    const crypto = require('node:crypto');
    const oldBuf = crypto.randomBytes(2000);
    const newBuf = crypto.randomBytes(2000);

    const fakeS3 = {
      downloadBuffer: jest.fn().mockResolvedValue(oldBuf),
      uploadBuffer: jest.fn(),
    };
    const fakeUpdateDiff = { create: jest.fn() };

    const diffService = require('./diff');
    const result = await diffService.generate({
      baseUpdate: { _id: 'BASE', bundleKey: 'p/BASE/bundle.hbc', bundleHash: 'oldhash' },
      newUpdate: { _id: 'NEW' },
      newBundleBuffer: newBuf,
      projectSlug: 'p',
      s3: fakeS3,
      UpdateDiff: fakeUpdateDiff,
    });

    expect(result).toBeNull();
    expect(fakeS3.uploadBuffer).not.toHaveBeenCalled();
    expect(fakeUpdateDiff.create).not.toHaveBeenCalled();
  });

  it('does not leave tmp files behind on upload failure', async () => {
    const oldBuf = await fs.readFile(path.join(fixturesDir, 'old.bin'));
    const newBuf = await fs.readFile(path.join(fixturesDir, 'new.bin'));

    const fakeS3 = {
      downloadBuffer: jest.fn().mockResolvedValue(oldBuf),
      uploadBuffer: jest.fn().mockRejectedValue(new Error('R2 boom')),
    };
    const fakeUpdateDiff = { create: jest.fn() };

    const before = new Set(
      (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('bsdiff-'))
    );

    const diffService = require('./diff');
    await expect(
      diffService.generate({
        baseUpdate: { _id: 'B', bundleKey: 'p/B/bundle.hbc', bundleHash: 'h' },
        newUpdate: { _id: 'N' },
        newBundleBuffer: newBuf,
        projectSlug: 'p',
        s3: fakeS3,
        UpdateDiff: fakeUpdateDiff,
      }),
    ).rejects.toThrow();

    const after = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('bsdiff-'));
    const leaked = after.filter((f) => !before.has(f));
    expect(leaked).toEqual([]);
  });
});
