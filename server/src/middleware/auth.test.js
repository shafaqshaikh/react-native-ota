jest.mock('../db/mongo', () => ({
  ApiKey: { findOne: jest.fn(), updateOne: jest.fn() },
  Project: { findById: jest.fn() },
  Session: { findOne: jest.fn(), updateOne: jest.fn() },
  User: { findById: jest.fn() },
}));

const { ApiKey, Project, Session, User } = require('../db/mongo');
const { requireAuth } = require('./auth');
const { hashToken } = require('../utils/session');

function makeReq(authHeader) {
  return {
    get: (h) => (h.toLowerCase() === 'authorization' ? authHeader : ''),
    headers: { authorization: authHeader },
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  ApiKey.updateOne.mockReturnValue({ catch: () => {} });
  Session.updateOne.mockReturnValue({ catch: () => {} });
});

describe('requireAuth', () => {
  it('rejects with 401 when Authorization header is missing', async () => {
    const req = makeReq('');
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a valid ota_live_* token via the API key path', async () => {
    ApiKey.findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'k1', projectId: 'p1' }),
    });
    Project.findById.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'p1', slug: 'demo' }),
    });
    const req = makeReq('Bearer ota_live_abcdef');
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.apiKey).toEqual({ _id: 'k1', projectId: 'p1' });
    expect(req.project).toEqual({ _id: 'p1', slug: 'demo' });
  });

  it('accepts a valid ota_sess_* token and attaches user + session', async () => {
    const future = new Date(Date.now() + 60_000);
    Session.findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: 's1', userId: 'u1', expiresAt: future, tokenHash: hashToken('ota_sess_abc') }),
    });
    User.findById.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'u1', email: 'a@b.test' }),
    });
    const req = makeReq('Bearer ota_sess_abc');
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ _id: 'u1', email: 'a@b.test' });
    expect(req.session._id).toBe('s1');
  });

  it('rejects an expired session token', async () => {
    const past = new Date(Date.now() - 60_000);
    Session.findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: 's1', userId: 'u1', expiresAt: past }),
    });
    const req = makeReq('Bearer ota_sess_abc');
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unknown token prefix', async () => {
    const req = makeReq('Bearer something_else_xyz');
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
