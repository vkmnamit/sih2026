/**
 * Express app factory — keeps the app separated from the listener so tests
 * can boot it on any port.
 */
import express from 'express';
import path from 'node:path';
import apiRoutes from './routes/index.js';
import { config } from './config/index.js';
import cors from 'cors';

import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';

export function createApp(): express.Express {
  const app = express();
  const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://sih-2026-eklavya.vercel.app',
    process.env.FRONTEND_URL,
  ].filter(Boolean) as string[];

  app.use(cors({
    origin: (origin, callback) => {
      // allow requests with no origin (like mobile apps, curl, or same-origin)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }
      return callback(null, true); // Permissive for hackathon demo
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));

  // Serve rendered MP4 reels and uploaded media
  app.use('/reels', express.static(config.reelsDir, { acceptRanges: true }));
  app.use('/uploads', express.static(config.uploadDir, { acceptRanges: true }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'eklavya-backend', time: new Date().toISOString() });
  });

  app.use('/api', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
