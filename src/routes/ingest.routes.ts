/**
 * Ingest routes — wire middleware chain to controllers:
 * upload (multer) → requireFile → validateExtension → controller.
 */
import { Router } from 'express';
import { ALLOWED_MEDIA_EXTENSIONS, ALLOWED_PDF_EXTENSIONS } from '../config/index.js';
import { ingestPdf, ingestVideo } from '../controllers/ingest.controller.js';
import { uploadSingle, extensionOf } from '../middleware/upload.middleware.js';
import { requireFile, validateExtension } from '../middleware/validate.middleware.js';

const router = Router();

router.post(
  '/pdf',
  uploadSingle,
  requireFile,
  validateExtension(ALLOWED_PDF_EXTENSIONS),
  ingestPdf
);

router.post(
  '/video',
  uploadSingle,
  requireFile,
  validateExtension(ALLOWED_MEDIA_EXTENSIONS),
  ingestVideo
);

/**
 * POST /api/ingest — auto-detect PDF vs video/audio by extension.
 * (Extension check happens inside the controller, since the target pipeline
 * depends on it.)
 */
router.post('/', uploadSingle, requireFile, (req, res, next) => {
  const ext = extensionOf(req.file?.originalname ?? '');
  if (!ALLOWED_PDF_EXTENSIONS.includes(ext as never) &&
      !ALLOWED_MEDIA_EXTENSIONS.includes(ext as never)) {
    next(
      Object.assign(
        new Error(`Unsupported file type "${ext}". Allowed: ${[...ALLOWED_PDF_EXTENSIONS, ...ALLOWED_MEDIA_EXTENSIONS].join(', ')}`),
        { status: 400 }
      )
    );
    return;
  }
  if (ext === '.pdf') ingestPdf(req, res, next);
  else ingestVideo(req, res, next);
});

export default router;
