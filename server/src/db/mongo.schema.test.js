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

describe('User schema', () => {
  it('exports User model with required fields', () => {
    const { User } = require('./mongo');
    expect(User).toBeDefined();
    expect(User.modelName).toBe('User');
    const paths = User.schema.paths;
    expect(paths.email).toBeDefined();
    expect(paths.passwordHash).toBeDefined();
    expect(paths.name).toBeDefined();
    expect(paths.createdAt).toBeDefined();
  });

  it('declares unique index on email', () => {
    const { User } = require('./mongo');
    const indexes = User.schema.indexes();
    const emailIdx = indexes.find(([fields]) => fields.email === 1);
    expect(emailIdx).toBeDefined();
    expect(emailIdx[1].unique).toBe(true);
  });
});

describe('Session schema', () => {
  it('exports Session model with required fields', () => {
    const { Session } = require('./mongo');
    expect(Session).toBeDefined();
    expect(Session.modelName).toBe('Session');
    const paths = Session.schema.paths;
    expect(paths.userId).toBeDefined();
    expect(paths.tokenHash).toBeDefined();
    expect(paths.expiresAt).toBeDefined();
    expect(paths.createdAt).toBeDefined();
    expect(paths.lastUsedAt).toBeDefined();
    expect(paths.userAgent).toBeDefined();
  });

  it('declares index on tokenHash and TTL index on expiresAt', () => {
    const { Session } = require('./mongo');
    const indexes = Session.schema.indexes();
    const tokenIdx = indexes.find(([fields]) => fields.tokenHash === 1);
    expect(tokenIdx).toBeDefined();
    const ttlIdx = indexes.find(([fields]) => fields.expiresAt === 1);
    expect(ttlIdx).toBeDefined();
    expect(ttlIdx[1].expireAfterSeconds).toBe(0);
  });
});
