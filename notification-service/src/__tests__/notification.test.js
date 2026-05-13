'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.NODE_ENV = 'test';

const mockNotif = {
  _id: 'n1',
  userId: 'u1',
  type: 'message',
  title: 'New message from Alice',
  body: 'Hello!',
  read: false,
  meta: {},
  createdAt: new Date().toISOString(),
};

jest.mock('mongoose', () => {
  const mockModel = {
    find: jest.fn(() => ({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([mockNotif]),
    })),
    findOneAndUpdate: jest.fn().mockResolvedValue({ ...mockNotif, read: true }),
    updateMany: jest.fn().mockResolvedValue({ nModified: 1 }),
    countDocuments: jest.fn().mockResolvedValue(1),
    insertMany: jest.fn().mockResolvedValue([mockNotif]),
  };

  return {
    connect: jest.fn().mockResolvedValue(undefined),
    Schema: class {
      constructor() {}
      static Types = { Mixed: Object };
    },
    model: jest.fn(() => mockModel),
  };
});

jest.mock('amqplib', () => ({
  connect: jest.fn().mockRejectedValue(new Error('rabbitmq not available in test')),
}));

const { app } = require('../index');

const token = jwt.sign({ userId: 'u1', email: 'a@a.com' }, 'test-secret', { expiresIn: '1h' });
const authHeader = { Authorization: `Bearer ${token}` };

describe('GET /health', () => {
  it('returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('notification-service');
  });
});

describe('GET /notifications/count', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/notifications/count');
    expect(res.status).toBe(401);
  });

  it('returns unread count with token', async () => {
    const res = await request(app).get('/notifications/count').set(authHeader);
    expect(res.status).toBe(200);
    expect(typeof res.body.unreadCount).toBe('number');
  });
});

describe('GET /notifications', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/notifications');
    expect(res.status).toBe(401);
  });

  it('returns notifications and unreadCount with token', async () => {
    const res = await request(app).get('/notifications').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('notifications');
    expect(res.body).toHaveProperty('unreadCount');
    expect(Array.isArray(res.body.notifications)).toBe(true);
  });
});

describe('PATCH /notifications/read-all', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).patch('/notifications/read-all');
    expect(res.status).toBe(401);
  });

  it('marks all as read', async () => {
    const res = await request(app).patch('/notifications/read-all').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('All marked as read');
  });
});

describe('PATCH /notifications/:id', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).patch('/notifications/n1');
    expect(res.status).toBe(401);
  });

  it('marks one notification as read', async () => {
    const res = await request(app).patch('/notifications/n1').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.read).toBe(true);
  });
});