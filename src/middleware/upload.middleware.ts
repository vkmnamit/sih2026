/**
 * Upload middleware — stages multipart uploads to disk (the pipelines need
 * real file paths) with size limits, UTF-8 normalization, and unique names.
 */
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config/index.js';

/** Fix encoding of originalname (e.g. latin1 -> utf8 for macOS screenshots/recordings with narrow spaces) */
export function normalizeFilename(raw: string): string {
  if (!raw) return 'upload';
  let s = raw;
  try {
    const fixed = Buffer.from(raw, 'latin1').toString('utf8');
    if (!fixed.includes('\uFFFD')) {
      s = fixed;
    }
  } catch {}
  // Normalize unicode (NFC) and normalize invisible/narrow non-breaking spaces (\u202F, \u00A0) to standard spaces
  return s.normalize('NFC').replace(/[\u202F\u00A0\u2000-\u200B]/g, ' ').trim();
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => {
    file.originalname = normalizeFilename(file.originalname);
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
