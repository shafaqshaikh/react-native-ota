jest.mock('../db/mongo', () => ({
  User: { findOne: jest.fn() },
  Session: {
    create: jest.fn(),
    deleteOne: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
  AuditLog: { create: jest.fn() },
}));

const express = require('express');
const request = require('supertest');
const { User, Session, AuditLog } = require('../db/mongo');
const passwordUtil = require('../utils/password');

const auth = require('./auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', auth);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  AuditLog.create.mockResolvedValue({});
  Session.updateOne.mockReturnValue({ catch: () => {} });
});

describe('POST /v1/login', () => {
  it('returns 400 on missing email or password', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/login').send({});
    expect(res.status).toBe(400);
  });

  it('returns 401 with generic message when email is unknown', async () => {
    User.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    const app = buildApp();
    const res = await request(app).post('/v1/login').send({ email: 'x@y.z', password: 'pw' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('returns 401 when password is wrong', async () => {
    const hash = await passwordUtil.hash('correct');
    User.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'u1', email: 'a@b.test', passwordHash: hash }) });
    const app = buildApp();
    const res = await request(app).post('/v1/login').send({ email: 'a@b.test', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('returns a fresh ota_sess_* token on success and creates a Session row', async () => {
    const hash = await passwordUtil.hash('correct');
    User.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'u1', email: 'a@b.test', name: '', passwordHash: hash }) });
    Session.create.mockResolvedValue({ _id: 's1' });
    const app = buildApp();
    const res = await request(app).post('/v1/login').send({ email: 'a@b.test', password: 'correct' });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^ota_sess_[a-f0-9]+$/);
    expect(res.body.user.email).toBe('a@b.test');
    expect(Session.create).toHaveBeenCalled();
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'login' }));
  });
});

describe('POST /v1/logout', () => {
  it('returns 401 without a session', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/logout');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/me', () => {
  it('returns 401 without a session', async () => {
    const app = buildApp();
    const res = await request(app).get('/v1/me');
    expect(res.status).toBe(401);
  });
});
