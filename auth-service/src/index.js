'use strict';

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const jwt = require('jsonwebtoken');
const redis = require('redis');
const { createClient } = redis;
const mongoose = require('mongoose');
const promClient = require('prom-client');
const winston = require('winston');

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

// ─── Metrics ─────────────────────────────────────────────────────────────────
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2],
  registers: [register],
});

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}));
// ─── Redis ───────────────────────────────────────────────────────────────────
let redisClient;
(async () => {
  redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  redisClient.on('error', (err) => logger.error('Redis error', { err: err.message }));
  try {
    await redisClient.connect();
    logger.info('Redis connected');
  } catch (err) {
    logger.warn('Redis unavailable – session caching disabled', { err: err.message });
  }
})();

// ─── MongoDB ─────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI || 'mongodb://localhost:27017/verbalyn')
  .then(() => logger.info('MongoDB connected'))
  .catch((err) => logger.error('MongoDB connection error', { err: err.message }));

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, unique: true },
    email: { type: String, required: true },
    name: String,
    avatar: String,
  },
  { timestamps: true }
);
const User = mongoose.model('User', userSchema);

// ─── Session ─────────────────────────────────────────────────────────────────
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 },
  })
);

// ─── Passport / Google OAuth2 ────────────────────────────────────────────────
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || 'mock-client-id',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'mock-secret',
      callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/auth/google/callback',
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        let user = await User.findOne({ googleId: profile.id });
        if (!user) {
          user = await User.create({
            googleId: profile.id,
            email: profile.emails[0].value,
            name: profile.displayName,
            avatar: profile.photos?.[0]?.value,
          });
          logger.info('New user created', { userId: user._id });
        }
        return done(null, user);
      } catch (err) {
        logger.error('Google OAuth error', { err: err.message });
        return done(err);
      }
    }
  )
);
passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

app.use(passport.initialize());
app.use(passport.session());

// ─── Middleware: metrics instrumentation ─────────────────────────────────────
app.use((req, _res, next) => {
  req._startTime = Date.now();
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'auth-service' }));

// Metrics
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Google OAuth initiation
app.get(
  '/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google OAuth callback
app.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=oauth_failed` }),
  async (req, res) => {
    try {
      const payload = {
        userId: req.user._id,
        email: req.user.email,
        name: req.user.name,
      };
      const token = jwt.sign(payload, process.env.JWT_SECRET || 'dev-jwt-secret', {
        expiresIn: '7d',
      });

      // Cache session in Redis
      if (redisClient?.isReady) {
        await redisClient.setEx(`session:${req.user._id}`, 7 * 24 * 3600, token);
      }

      logger.info('User authenticated', { userId: req.user._id });
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}?token=${token}`);
    } catch (err) {
      logger.error('Token generation error', { err: err.message });
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=server_error`);
    }
  }
);

// Token verification (used by other services / gateway)
app.post('/auth/verify', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-jwt-secret');

    // Optional: check Redis blacklist
    if (redisClient?.isReady) {
      const blacklisted = await redisClient.get(`blacklist:${token}`);
      if (blacklisted) return res.status(401).json({ error: 'Token revoked' });
    }

    return res.json({ valid: true, user: decoded });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Logout
app.post('/auth/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ') && redisClient?.isReady) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.decode(token);
      const ttl = decoded?.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 3600;
      if (ttl > 0) await redisClient.setEx(`blacklist:${token}`, ttl, '1');
      await redisClient.del(`session:${decoded?.userId}`);
    } catch { /* ignore */ }
  }
  req.logout(() => res.json({ message: 'Logged out' }));
});

// ─── Metrics: record duration after response ──────────────────────────────────
app.use((req, res, next) => {
  res.on('finish', () => {
    const duration = (Date.now() - req._startTime) / 1000;
    httpRequestDuration.labels(req.method, req.route?.path || req.path, res.statusCode).observe(duration);
  });
  next();
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => logger.info(`auth-service listening on :${PORT}`));
}

module.exports = app;