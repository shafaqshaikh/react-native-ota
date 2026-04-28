const mongoose = require('mongoose');

describe('UpdateDiff schema', () => {
  it('exports UpdateDiff model with required fields', () => {
    const { UpdateDiff } = require('./mongo');
    expect(UpdateDiff).toBeDefined();
    expect(UpdateDiff.modelName).toBe('UpdateDiff');
    const paths = UpdateDiff.schema.paths;
    expect(paths.toUpdateId).toBeDefined();
    expect(paths.fromUpdateId).toBeDefined();
    expect(paths.fromBundleHash).toBeDefined();
    expect(paths.patchKey).toBeDefined();
    expect(paths.patchHash).toBeDefined();
    expect(paths.patchSize).toBeDefined();
  });

  it('declares (toUpdateId, fromBundleHash) compound index', () => {
    const { UpdateDiff } = require('./mongo');
    const indexes = UpdateDiff.schema.indexes();
    const compound = indexes.find(
      ([fields]) => fields.toUpdateId === 1 && fields.fromBundleHash === 1
    );
    expect(compound).toBeDefined();
    expect(compound[1].unique).toBe(true);
  });
});
