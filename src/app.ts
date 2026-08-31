/**
 * Express app factory — keeps the app separated from the listener so tests
 * can boot it on any port.
 */
import express from 'express';
import path from 'node:path';
import apiRoutes from './routes/index.js';
import { config } from './config/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';

export function createApp(): express.Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Test frontend (public/index.html) — served by the backend so the page
  // is same-origin with /api/* and needs no CORS setup.
  // Resolved from this file's location (src/ or dist/) → project root/public.
  app.use(express.static(path.resolve(import.meta.dirname, '..', 'public')));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'eklavya-backend', time: new Date().toISOString() });
  });

  app.use('/api', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
