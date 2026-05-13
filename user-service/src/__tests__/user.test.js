'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.NODE_ENV = 'test';

jest.mock('mongoose', () => {
  const makeSelect = (val) => ({ select: jest.fn().mockResolvedValue(val) });
  const makeSelectLimit = (val) => ({
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    skip: jest.fn().mockResolvedValue(val),
  });

  const mockUser = { _id: 'u1', email: 'a@a.com', name: 'A', bio: 'Hello', avatar: '' };

  return {
    connect: jest.fn().mockResolvedValue(undefined),
    Schema: class { constructor() {} },
    model: jest.fn(() => ({
      findById: jest.fn((id) => {
        if (id === 'u1') return makeSelect(mockUser);
        return makeSelect(null);
      }),
      findByIdAndUpdate: jest.fn(() => makeSelect({ ...mockUser, name: 'Updated' })),
      findByIdAndDelete: jest.fn().mockResolvedValue(mockUser),
      find: jest.fn(() => makeSelectLimit([mockUser])),
    })),
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
  });
});

describe('GET /users/profile', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/users/profile');
    expect(res.status).toBe(401);
  });

  it('returns 401 with malformed token', async () => {
    const res = await request(app)
      .get('/users/profile')
      .set('Authorization', 'Bearer bad.token');
    expect(res.status).toBe(401);
  });

  it('returns 200 and profile with valid token', async () => {
    const res = await request(app).get('/users/profile').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('a@a.com');
  });
});

describe('PATCH /users/profile', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).patch('/users/profile').send({ name: 'New' });
    expect(res.status).toBe(401);
  });

  it('returns 200 with updated name', async () => {
    const res = await request(app)
      .patch('/users/profile')
      .set(authHeader)
      .send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
  });
});

describe('GET /users', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/users');
    expect(res.status).toBe(401);
  });

  it('returns list of users with valid token', async () => {
    const res = await request(app).get('/users').set(authHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('DELETE /users/profile', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).delete('/users/profile');
    expect(res.status).toBe(401);
  });

  it('returns 200 and deletes account', async () => {
    const res = await request(app).delete('/users/profile').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Account deleted');
  });
});