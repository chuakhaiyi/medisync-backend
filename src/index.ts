/**
 * MediSync+ Backend Server
 * Entry point for the hospital integration API.
 */

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { connectDb, disconnectDb } from './db/client';
import { logger } from './utils/logger';

import authRouter from './routes/auth';
import patientsRouter from './routes/patients';
import recordsRouter from './routes/records';
import syncRouter from './routes/sync';
import aiRouter from './routes/ai';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// CORS — only allow configured origins
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server calls (no origin) and allowed origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Hospital-API-Key', 'X-Admin-Secret'],
}));

// Rate limiting — protect against abuse
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
}));

// Body parsing & compression
app.use(express.json({ limit: '1mb' }));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0' }));

app.use('/api/auth', authRouter);
app.use('/api/patients', patientsRouter);
app.use('/api/records', recordsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/ai', aiRouter);

// ── Error Handler ─────────────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  await connectDb();
  app.listen(PORT, () => {
    logger.info(`MediSync+ backend running on port ${PORT} (${process.env.NODE_ENV})`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await disconnectDb();
  process.exit(0);
});

start().catch(err => {
  logger.error('Failed to start server', { err });
  process.exit(1);
});

export default app;
