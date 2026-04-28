// Mock the native module before importing updater
jest.mock('../native', () => ({
  __esModule: true,
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
  __esModule: true,
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

// Use jest.mocked() for typed mock accessors — if the real signatures change,
// callsites here will fail at compile time rather than silently at runtime.
const mockedNative = jest.mocked(Native);
const mockedStorage = {
  getCurrent: jest.mocked(Storage.getCurrent),
  setCurrent: jest.mocked(Storage.setCurrent),
  setPrevious: jest.mocked(Storage.setPrevious),
  cleanup: jest.mocked(Storage.cleanup),
};

describe('downloadUpdate — delta path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configure({ serverUrl: 'https://server.test', appVersion: '1.0', runtimeVersion: '1.0' });
  });

  it('takes the delta path when manifest has diff fields and current.bundleHash matches', async () => {
    mockedStorage.getCurrent.mockResolvedValue({
      updateId: 'OLD',
      bundlePath: '/tmp/OLD/bundle.hbc',
      bundleHash: 'oldhash123',
      status: 'stable',
      appVersion: '1.0',
      runtimeVersion: '1.0',
      appliedAt: 0,
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

    mockedNative.sha256File
      .mockResolvedValueOnce('patchhash')
      .mockResolvedValueOnce('newhash456');

    await downloadUpdate({
      available: true,
      updateId: 'NEW',
      bundleHash: 'newhash456',
      manifestUrl: '/v1/manifest/NEW',
    });

    expect(mockedNative.downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('/patch.bin'),
      expect.stringContaining('bundle.patch'),
    );
    expect(mockedNative.applyPatch).toHaveBeenCalledWith(
      '/tmp/OLD/bundle.hbc',
      expect.stringContaining('bundle.patch'),
      expect.stringContaining('bundle.hbc.tmp'),
    );
    expect(mockedNative.moveFile).toHaveBeenCalled();
    expect(mockedNative.downloadFile).not.toHaveBeenCalledWith(
      expect.stringContaining('/full.hbc'),
      expect.anything(),
    );
  });

  it('falls back to full download when patch hash mismatches', async () => {
    mockedStorage.getCurrent.mockResolvedValue({
      updateId: 'OLD',
      bundlePath: '/tmp/OLD/bundle.hbc',
      bundleHash: 'oldhash123',
      status: 'stable',
      appVersion: '1.0',
      runtimeVersion: '1.0',
      appliedAt: 0,
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

    mockedNative.sha256File
      .mockResolvedValueOnce('WRONG-PATCH-HASH')
      .mockResolvedValueOnce('newhash456');

    await downloadUpdate({
      available: true,
      updateId: 'NEW',
      bundleHash: 'newhash456',
      manifestUrl: '/v1/manifest/NEW',
    });

    expect(mockedNative.downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('/full.hbc'),
      expect.anything(),
    );
    expect(mockedNative.moveFile).toHaveBeenCalled();
  });
});
