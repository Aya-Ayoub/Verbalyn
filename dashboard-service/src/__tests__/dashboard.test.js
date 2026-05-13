'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.NODE_ENV = 'test';

//Mock mongoose 
const mockStats = {
  totalUsers: 42,
  totalMessages: 1337,
  activeUsers: 5,
  messagesLast24h: 120,
};

jest.mock('mongoose', () => {
  const mockUserModel = {
    countDocuments: jest.fn().mockResolvedValue(42),
  };
  const mockMessageModel = {
    countDocuments: jest.fn().mockResolvedValue(1337),
    aggregate: jest.fn().mockResolvedValue([{ _id: 'general', count: 80 }]),
  };

  let callCount = 0;
  const modelFactory = jest.fn(() => {
    callCount++;
    return callCount % 2 === 1 ? mockUserModel : mockMessageModel;
  });

  return {
    connect: jest.fn().mockResolvedValue(undefined),
    Schema: class {
      constructor() {}
    },
    model: modelFactory,
  };
});

const app = require('../index');

const token = jwt.sign({ userId: 'u1', email: 'a@a.com' }, 'test-secret', { expiresIn: '1h' });
const authHeader = { Authorization: `Bearer ${token}` };

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('dashboard-service');
  });
});

describe('GET /dashboard/stats', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/dashboard/stats');
    expect(res.status).toBe(401);
  });

  it('returns stats object with valid token', async () => {
    const res = await request(app).get('/dashboard/stats').set(authHeader);
    expect(res.status).toBe(200);
    expect(typeof res.body.totalUsers).toBe('number');
    expect(typeof res.body.totalMessages).toBe('number');
    expect(typeof res.body.uptime).toBe('string');
    expect(res.body).toHaveProperty('generatedAt');
  });

  it('returns cached stats on second call', async () => {
    const res1 = await request(app).get('/dashboard/stats').set(authHeader);
    const res2 = await request(app).get('/dashboard/stats').set(authHeader);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Both should return the same generatedAt
    expect(res1.body.generatedAt).toBe(res2.body.generatedAt);
  });
});

describe('GET /dashboard/health', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/dashboard/health');
    expect(res.status).toBe(401);
  });

  it('returns services array with token', async () => {
    const res = await request(app).get('/dashboard/health').set(authHeader);
    // Will return 207 since services are unreachable in test
    expect([200, 207]).toContain(res.status);
    expect(Array.isArray(res.body.services)).toBe(true);
  });
});

describe('GET /metrics', () => {
  it('returns prometheus metrics', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });
});