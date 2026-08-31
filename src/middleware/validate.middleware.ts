/**
 * Validation middleware — rejects requests with no file or a disallowed
 * extension before they ever reach the controller.
 */
import type { NextFunction, Request, Response } from 'express';
import { extensionOf } from './upload.middleware.js';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function requireFile(req: Request, _res: Response, next: NextFunction): void {
  if (!req.file) {
    next(new HttpError(400, 'No file uploaded. Field name must be "file".'));
    return;
  }
  next();
}

export function validateExtension(allowed: readonly string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ext = extensionOf(req.file?.originalname ?? '');
    if (!allowed.includes(ext)) {
      next(
        new HttpError(
          400,
          `Unsupported file type "${ext}". Allowed: ${allowed.join(', ')}`
        )
      );
      return;
    }
    next();
  };
}
