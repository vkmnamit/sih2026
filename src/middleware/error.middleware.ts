/**
 * Error-handling middleware — the single place where failures are converted
 * into consistent JSON responses.
 */
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { HttpError } from './validate.middleware.js';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ ok: false, error: 'Not found' });
}

interface KnownError extends Error {
  status?: number;
  code?: string;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const e = err as KnownError;

  // Multer errors (payload too large, unexpected field, ...)
  if (e instanceof multer.MulterError) {
    res.status(413).json({ ok: false, error: `Upload error: ${e.message}` });
    return;
  }

  const status = e instanceof HttpError ? e.status : e.status ?? 500;
  if (status >= 500) {
    console.error('[error.middleware]', e);
  } else {
    console.warn('[error.middleware]', e.message);
  }
  res.status(status).json({ ok: false, error: e.message || 'Internal server error' });
}
