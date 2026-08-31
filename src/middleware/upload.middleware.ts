/**
 * Upload middleware — stages multipart uploads to disk (the pipelines need
 * real file paths) with size limits and unique names.
 */
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config/index.js';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => {
    const ext = extensionOf(file.originalname);
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

export const uploadSingle = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
}).single('file');

/** Lowercased extension including the dot, or "" when absent */
export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? '' : name.slice(idx).toLowerCase();
}
