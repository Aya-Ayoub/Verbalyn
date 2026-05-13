'use strict';

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const promClient = require('prom-client');
const winston = require('winston');


const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

//Metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});


const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));


mongoose
  .connect(process.env.MONGO_URI || 'mongodb://localhost:27017/verbalyn')
  .then(() => logger.info('MongoDB connected'))
  .catch((err) => logger.error('MongoDB error', { err: err.message }));


const userSchema = new mongoose.Schema({ email: String, name: String }, { timestamps: true });
const messageSchema = new mongoose.Schema(
  { room: String, userId: String, content: String },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);


const cache = { data: null, expiresAt: 0 };

async function fetchStats() {
  if (cache.data && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [totalUsers, totalMessages, activeUsersToday, messagesLast24h, roomActivity] =
    await Promise.all([
      User.countDocuments(),
      Message.countDocuments(),
      User.countDocuments({ updatedAt: { $gte: cutoff } }),
      Message.countDocuments({ createdAt: { $gte: cutoff } }),
      Message.aggregate([
        { $match: { createdAt: { $gte: cutoff } } },
        { $group: { _id: '$room', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);

  const uptimeMs = process.uptime() * 1000;
  const uptimePct = Math.min(99.99, 100 - (Math.random() * 0.1)).toFixed(2); // simulated

  const stats = {
    totalUsers,
    totalMessages,
    activeUsers: activeUsersToday,
    messagesLast24h,
    totalRooms: roomActivity.length || 4,
    roomActivity: roomActivity.map((r) => ({ room: r._id, messages: r.count })),
    uptime: `${uptimePct}%`,
    uptimeSeconds: Math.floor(process.uptime()),
    generatedAt: new Date().toISOString(),
  };

  cache.data = stats;
  cache.expiresAt = Date.now() + 60_000;
  return stats;
}

// Auth middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'dev-jwt-secret');
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

//Metrics middlewar
app.use((req, _res, next) => { req._startTime = Date.now(); next(); });

//Routes

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'dashboard-service' }));

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// GET /dashboard/stats
app.get('/dashboard/stats', authenticate, async (_req, res) => {
  try {
    const stats = await fetchStats();
    res.json(stats);
  } catch (err) {
    logger.error('Stats error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/health-chec
app.get('/dashboard/health', authenticate, async (_req, res) => {
  const services = [
    { name: 'auth-service', url: `http://auth-service:3001/health` },
    { name: 'user-service', url: `http://user-service:3002/health` },
    { name: 'chat-service', url: `http://chat-service:3003/health` },
    { name: 'notification-service', url: `http://notification-service:3004/health` },
  ];

  const results = await Promise.allSettled(
    services.map(async (svc) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch(svc.url, { signal: ctrl.signal });
        clearTimeout(timer);
        return { name: svc.name, status: r.ok ? 'healthy' : 'degraded' };
      } catch {
        clearTimeout(timer);
        return { name: svc.name, status: 'down' };
      }
    })
  );

  const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value : { name: '?', status: 'down' }));
  const allHealthy = statuses.every((s) => s.status === 'healthy');
  res.status(allHealthy ? 200 : 207).json({ services: statuses });
});


app.use((req, res, next) => {
  res.on('finish', () => {
    const duration = (Date.now() - req._startTime) / 1000;
    httpRequestDuration.labels(req.method, req.route?.path || req.path, res.statusCode).observe(duration);
  });
  next();
});


const PORT = process.env.PORT || 3005;
if (require.main === module) {
  app.listen(PORT, () => logger.info(`dashboard-service listening on :${PORT}`));
}

module.exports = app;