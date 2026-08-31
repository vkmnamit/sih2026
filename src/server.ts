/**
 * Eklavya backend — server bootstrap.
 *
 * Two ingestion pipelines:
 *   PDF   → MuPDF text extraction (PyMuPDF engine), OCR fallback per scanned page
 *   Video → ffmpeg audio extraction → whisper.cpp transcription + timestamps
 * Both → shared chunker → (embeddings → vector DB → RAG  [next stage])
 */
import { createApp } from './app.js';
import { config, ALLOWED_MEDIA_EXTENSIONS, ALLOWED_PDF_EXTENSIONS } from './config/index.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`[eklavya-backend] listening on http://localhost:${config.port}`);
  console.log(`  POST /api/ingest/pdf   (multipart field "file": ${ALLOWED_PDF_EXTENSIONS.join(', ')})`);
  console.log(`  POST /api/ingest/video (multipart field "file": ${ALLOWED_MEDIA_EXTENSIONS.join(', ')})`);
  console.log(`  POST /api/ingest       (auto-detect PDF vs video/audio)`);
  console.log(`  GET  /health`);
});
