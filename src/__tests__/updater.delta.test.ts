// Mock the native module before importing updater
jest.mock('../native', () => ({
  Native: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    downloadFile: jest.fn().mockResolvedValue(undefined),
    sha256File: jest.fn(),
    moveFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    applyPatch: jest.fn().mockResolvedValue(undefined),
    unzipFile: jest.fn().mockResolvedValue(undefined),
  },
  documentDirectory: '/tmp/docs',
}));

jest.mock('../storage', () => ({
  bundleDir: (id: string) => `/tmp/${id}`,
  getCurrent: jest.fn(),
  setCurrent: jest.fn(),
  setPrevious: jest.fn(),
  cleanup: jest.fn(),
}));

const fetchMock = jest.fn();
(global as any).fetch = fetchMock;

import { Native } from '../native';
import * as Storage from '../storage';
import { downloadUpdate, configure } from '../updater';

describe('downloadUpdate — delta path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configure({ serverUrl: 'https://server.test', appVersion: '1.0', runtimeVersion: '1.0' });
  });

  it('takes the delta path when manifest has diff fields and current.bundleHash matches', async () => {
    (Storage.getCurrent as jest.Mock).mockResolvedValue({
      updateId: 'OLD',
      bundlePath: '/tmp/OLD/bundle.hbc',
      bundleHash: 'oldhash123',
    });

    const manifest = {
      id: 'NEW',
      bundleHash: 'newhash456',
      bundleUrl: '/full.hbc',
      diffUrl: '/patch.bin',
      diffHash: 'patchhash',
      diffSize: 500,
      fromBundleHash: 'oldhash123',
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => manifest,
    });

    (Native.sha256File as jest.Mock)
      .mockResolvedValueOnce('patchhash')
      .mockResolvedValueOnce('newhash456');

    await downloadUpdate({
      available: true,
      updateId: 'NEW',
      bundleHash: 'newhash456',
      manifestUrl: '/v1/manifest/NEW',
    });

    expect(Native.downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('/patch.bin'),
      expect.stringContaining('bundle.patch'),
    );
    expect(Native.applyPatch).toHaveBeenCalledWith(
      '/tmp/OLD/bundle.hbc',
      expect.stringContaining('bundle.patch'),
      expect.stringContaining('bundle.hbc.tmp'),
    );
    expect(Native.moveFile).toHaveBeenCalled();
    expect(Native.downloadFile).not.toHaveBeenCalledWith(
      expect.stringContaining('/full.hbc'),
      expect.anything(),
    );
  });

  it('falls back to full download when patch hash mismatches', async () => {
    (Storage.getCurrent as jest.Mock).mockResolvedValue({
      updateId: 'OLD',
      bundlePath: '/tmp/OLD/bundle.hbc',
      bundleHash: 'oldhash123',
    });

    const manifest = {
      id: 'NEW',
      bundleHash: 'newhash456',
      bundleUrl: '/full.hbc',
      diffUrl: '/patch.bin',
      diffHash: 'expected-patch-hash',
      diffSize: 500,
      fromBundleHash: 'oldhash123',
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => manifest });

    (Native.sha256File as jest.Mock)
      .mockResolvedValueOnce('WRONG-PATCH-HASH')
      .mockResolvedValueOnce('newhash456');

    await downloadUpdate({
      available: true,
      updateId: 'NEW',
      bundleHash: 'newhash456',
      manifestUrl: '/v1/manifest/NEW',
    });

    expect(Native.downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('/full.hbc'),
      expect.anything(),
    );
    expect(Native.moveFile).toHaveBeenCalled();
  });
});
