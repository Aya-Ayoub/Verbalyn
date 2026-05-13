'use strict';

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const amqp = require('amqplib');
const promClient = require('prom-client');
const winston = require('winston');


const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

// ─── Metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const notificationsDelivered = new promClient.Counter({
  name: 'notifications_delivered_total',
  help: 'Total notifications delivered',
  registers: [register],
});


const app = express();
app.use(express.json());
app.use(cors({ origin: '*', credentials: false }));

// ─── MongoDB
mongoose
  .connect(process.env.MONGO_URI || 'mongodb://localhost:27017/verbalyn')
  .then(() => logger.info('MongoDB connected'))
  .catch((err) => logger.error('MongoDB error', { err: err.message }));

const notificationSchema = new mongoose.Schema({
  userId:   { type: String, required: true, index: true },
  senderId: { type: String, default: '' },
  type:     { type: String, default: 'message' },
  title:    { type: String, required: true },
  body:     { type: String, default: '' },
  read:     { type: Boolean, default: false },
  meta:     { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

const Notification = mongoose.model('Notification', notificationSchema);

//Auth middleware
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

// Metrics middleware
app.use((req, _res, next) => { req._startTime = Date.now(); next(); });

//Routes

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'notification-service' }));

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// GET /notifications/count
app.get('/notifications/count', authenticate, async (req, res) => {
  try {
    const unreadCount = await Notification.countDocuments({
      userId: req.user.userId,
      read: false,
    });
    res.json({ unreadCount });
  } catch (err) {
    logger.error('Count error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /notifications
app.get('/notifications', authenticate, async (req, res) => {
  try {
    const { limit = 20, skip = 0, unreadOnly } = req.query;
    const filter = { userId: req.user.userId };
    if (unreadOnly === 'true') filter.read = false;

    const [notifications, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .limit(Number(limit))
        .skip(Number(skip))
        .lean(),
      Notification.countDocuments({ userId: req.user.userId, read: false }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (err) {
    logger.error('List notifications error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /notifications/read-all — mark ALL as read
app.patch('/notifications/read-all', authenticate, async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user.userId, read: false },
      { $set: { read: true } }
    );
    res.json({ message: 'All marked as read', unreadCount: 0 });
  } catch (err) {
    logger.error('Mark all read error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.patch('/notifications/:id', authenticate, async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.userId },
      { $set: { read: true } },
      { new: true }
    );
    if (!notif) return res.status(404).json({ error: 'Not found' });
    res.json(notif);
  } catch (err) {
    logger.error('Mark read error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

//Metrics
app.use((req, res, next) => {
  res.on('finish', () => {
    const duration = (Date.now() - req._startTime) / 1000;
    httpRequestDuration
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .observe(duration);
  });
  next();
});

//RabbitMQ consumer
async function startConsumer(retries = 0) {
  const maxRetries = 10;
  try {
    const conn = await amqp.connect(
      process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672/'
    );
    const ch = await conn.createChannel();

    await ch.assertExchange('verbalyn', 'topic', { durable: true });
    const q = await ch.assertQueue('notifications', { durable: true });
    await ch.bindQueue(q.queue, 'verbalyn', 'message.sent');

    ch.prefetch(10);
    logger.info('RabbitMQ consumer ready');

    ch.consume(q.queue, async (msg) => {
      if (!msg) return;
      try {
        const event = JSON.parse(msg.content.toString());

        if (msg.fields.routingKey === 'message.sent') {
          const senderId  = event.userId || '';
          const senderName = event.name || event.email || 'Someone';
          const room      = event.room || 'general';
          const content   = event.content?.slice(0, 120) || '';

          
          let recipientIds = [];
          try {
            const msgCol = mongoose.connection.db.collection('messages');
            const ids = await msgCol.distinct('userId', { room });
            //exclude the sender
            recipientIds = ids.filter(
              (id) => id && id.toString() !== senderId.toString()
            );
          } catch (e) {
            logger.warn('Could not fetch room members', { err: e.message });
          }

          if (recipientIds.length === 0) {
            logger.info('No other room members to notify', { room });
            ch.ack(msg);
            return;
          }

          const docs = recipientIds.map((uid) => ({
            userId:    uid.toString(),
            senderId:  senderId,
            type:      'message',
            title:     `New message from ${senderName} in #${room}`,
            body:      content,
            read:      false,
            meta:      { room, messageId: event._id },
            createdAt: new Date(),
            updatedAt: new Date(),
          }));

          await Notification.insertMany(docs, { ordered: false });
          notificationsDelivered.inc(docs.length);
          logger.info('Notifications created', { count: docs.length, room });
        }

        ch.ack(msg);
      } catch (err) {
        logger.error('Consumer error', { err: err.message });
        ch.nack(msg, false, false);
      }
    });

    conn.on('error', () => setTimeout(() => startConsumer(0), 5000));
    conn.on('close', () => setTimeout(() => startConsumer(0), 5000));

  } catch (err) {
    if (retries < maxRetries) {
      const delay = Math.min(2000 * (retries + 1), 20000);
      logger.warn(`RabbitMQ not ready (attempt ${retries + 1}), retrying in ${delay}ms`);
      setTimeout(() => startConsumer(retries + 1), delay);
    } else {
      logger.warn('RabbitMQ unavailable — event notifications disabled');
    }
  }
}

const PORT = process.env.PORT || 3004;
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`notification-service listening on :${PORT}`);
    startConsumer();
  });
}

module.exports = { app, Notification };