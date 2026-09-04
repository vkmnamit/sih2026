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

const primaryPort = config.port;

app.listen(primaryPort, '0.0.0.0', () => {
  console.log(`[eklavya-backend] listening on http://0.0.0.0:${primaryPort}`);
  console.log(`  POST /api/ingest/pdf   (multipart field "file": ${ALLOWED_PDF_EXTENSIONS.join(', ')})`);
  console.log(`  POST /api/ingest/video (multipart field "file": ${ALLOWED_MEDIA_EXTENSIONS.join(', ')})`);
  console.log(`  POST /api/ingest       (auto-detect PDF vs video/audio)`);
  console.log(`  GET  /health`);
});

// Also bind secondary port (3000 or 8080) so both Railway default and local/custom port routings succeed seamlessly
const secondaryPort = primaryPort === 3000 ? 8080 : 3000;
try {
  const secondaryServer = app.listen(secondaryPort, '0.0.0.0', () => {
    console.log(`[eklavya-backend] secondary listener active on http://0.0.0.0:${secondaryPort}`);
  });
  secondaryServer.on('error', () => {
    // Port already bound or unavailable — silently ignore
  });
} catch {
  // Gracefully continue
}
