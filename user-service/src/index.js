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

//App
const app = express();
app.use(express.json());
app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}));

//MongoDB
mongoose
  .connect(process.env.MONGO_URI || 'mongodb://localhost:27017/verbalyn')
  .then(() => logger.info('MongoDB connected'))
  .catch((err) => logger.error('MongoDB error', { err: err.message }));

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String },
    email: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    bio: { type: String, default: '' },
    avatar: { type: String, default: '' },
  },
  { timestamps: true }
);
const User = mongoose.model('User', userSchema);

//Auth middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'dev-jwt-secret');
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

//Metrics middleware
app.use((req, _res, next) => {
  req._startTime = Date.now();
  next();
});

//Routes

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'user-service' }));

// Metrics
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// GET my profile
app.get('/users/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-__v -googleId');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    logger.error('Get profile error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH update my profile
app.patch('/users/profile', authenticate, async (req, res) => {
  try {
    const { name, bio, avatar } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (bio !== undefined) update.bio = bio;
    if (avatar !== undefined) update.avatar = avatar;

    const user = await User.findByIdAndUpdate(req.user.userId, { $set: update }, {
      new: true,
      runValidators: true,
    }).select('-__v -googleId');

    if (!user) return res.status(404).json({ error: 'User not found' });
    logger.info('Profile updated', { userId: req.user.userId });
    res.json(user);
  } catch (err) {
    logger.error('Update profile error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/users/:id', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('name bio avatar email');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    logger.error('Get user error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/users', authenticate, async (req, res) => {
  try {
    const { q, limit = 20, skip = 0 } = req.query;
    const filter = q ? { $or: [{ name: new RegExp(q, 'i') }, { email: new RegExp(q, 'i') }] } : {};
    const users = await User.find(filter)
      .select('name bio avatar email')
      .limit(Number(limit))
      .skip(Number(skip));
    res.json(users);
  } catch (err) {
    logger.error('List users error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.delete('/users/profile', authenticate, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user.userId);
    logger.info('User deleted', { userId: req.user.userId });
    res.json({ message: 'Account deleted' });
  } catch (err) {
    logger.error('Delete user error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.use((req, res, next) => {
  res.on('finish', () => {
    const duration = (Date.now() - req._startTime) / 1000;
    httpRequestDuration
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .observe(duration);
  });
  next();
});


const PORT = process.env.PORT || 3002;
if (require.main === module) {
  app.listen(PORT, () => logger.info(`user-service listening on :${PORT}`));
}

module.exports = app;
