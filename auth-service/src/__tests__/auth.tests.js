'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

//Env setup
process.env.JWT_SECRET = 'test-secret';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.GOOGLE_CLIENT_ID = 'mock-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'mock-secret';
process.env.NODE_ENV = 'test';

//Mock mongoose 
const mockUser = {
  _id: 'user-id-123',
  googleId: 'google-123',
  email: 'test@example.com',
  name: 'Test User',
  avatar: 'https://example.com/avatar.jpg',
};

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  Schema: class {
    constructor() {}
  },
  model: jest.fn(() => ({
    findOne: jest.fn().mockResolvedValue(mockUser),
    findById: jest.fn().mockResolvedValue(mockUser),
    create: jest.fn().mockResolvedValue(mockUser),
  })),
}));

//Mock redis
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    setEx: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
    isReady: true,
  })),
}));

//Mock passportoauth20
jest.mock('passport-google-oauth20', () => ({
  Strategy: class {
    constructor(_opts, _verify) {}
    name = 'google';
    authenticate() {}
  },
}));

const app = require('../index');

const validToken = jwt.sign(
  { userId: 'user-id-123', email: 'test@example.com', name: 'Test User' },
  'test-secret',
  { expiresIn: '1h' }
);

//health
describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('auth-service');
  });
});

//metrics 
describe('GET /metrics', () => {
  it('returns prometheus metrics', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });
});

//auth/verify
describe('POST /auth/verify', () => {
  it('returns 401 when no token provided', async () => {
    const res = await request(app).post('/auth/verify');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('returns 401 for invalid token', async () => {
    const res = await request(app)
      .post('/auth/verify')
      .set('Authorization', 'Bearer bad.token.here');
    expect(res.status).toBe(401);
  });

  it('returns valid:true for a good token', async () => {
    const res = await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.user.email).toBe('test@example.com');
  });
});

//auth/logout
describe('POST /auth/logout', () => {
  it('returns 200 and logout message', async () => {
    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged out');
  });

  it('returns 200 even without a token', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(200);
  });
});