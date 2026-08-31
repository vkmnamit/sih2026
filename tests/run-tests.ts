/**
 * End-to-end tests for both ingestion pipelines.
 *
 *   1. Chunker unit tests
 *   2. PDF pipeline  — text PDF  (mupdf path)          fixtures/text-notes.pdf
 *   3. PDF pipeline  — scanned PDF (OCR fallback path)  fixtures/scanned-notes.pdf
 *   4. Video pipeline — mp3 audio (whisper path)        fixtures/lecture.mp3
 *   5. HTTP API      — server + /api/ingest endpoints (multipart upload)
 *
 * Run: npm test   (requires fixtures — node tests/make-fixtures.js)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
const PORT = 3999;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ---------------------------------------------------------------- 1. chunker
console.log('\n[1] Chunker');
{
  const { chunkText, chunkSegments } = await import('../dist/services/chunking.service.js');

  const longText = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const chunks = chunkText(longText, { maxChars: 500, overlapChars: 80 });
  check('splits long text into chunks', chunks.length > 1, `${chunks.length} chunks`);
  check('chunks respect max size', chunks.every((c) => c.charCount <= 500 + 90));
  check('chunks carry ids', chunks.every((c) => c.id.startsWith('chunk_')));

  const segChunks = chunkSegments(
    [
      { text: 'Page one content here', meta: { page: 1 } },
      { text: 'Page two content here', meta: { page: 2 } },
    ],
    { maxChars: 25 }
  );
  check('segment chunking merges metadata', segChunks.some((c) => c.meta.page >= 1));

  check('empty input → no chunks', chunkText('   ').length === 0);
}

// ------------------------------------------------------------ 2. PDF (text)
console.log('\n[2] PDF pipeline — text PDF (mupdf path)');
{
  const { extractPdfSegments, extractPdf } = await import('../dist/services/pdf.service.js');
  const file = path.join(FIX, 'text-notes.pdf');

  const { stats, pages } = await extractPdf(file);
  check('extracts 1 page', stats.totalPages === 1, JSON.stringify(stats));
  check('uses embedded-text extraction (no OCR)', stats.ocrPages === 0);
  check('contains expected content', pages[0].text.includes('Binary search works on a sorted array'));
  check('keeps page numbers', pages[0].page === 1);

  const segments = await extractPdfSegments(file);
  check('extractPdfSegments attaches page metadata', segments[0].meta.page === 1 && segments[0].meta.extraction === 'mupdf');
}

// ----------------------------------------------------------- 3. PDF (OCR)
console.log('\n[3] PDF pipeline — scanned PDF (OCR fallback)');
{
  const { extractPdf } = await import('../dist/services/pdf.service.js');
  const file = path.join(FIX, 'scanned-notes.pdf');

  const { stats, pages } = await extractPdf(file);
  check('detects scanned page and OCRs it', stats.ocrPages === 1, JSON.stringify(stats));
  check('OCR recovers readable text', /binary search/i.test(pages[0].text), pages[0].text.slice(0, 80));
}

// ---------------------------------------------------------- 4. Video (whisper)
console.log('\n[4] Video pipeline — audio transcription (whisper, may take a while)');
{
  const { extractVideoSegments, extractAudio } = await import('../dist/services/video.service.js');
  const file = path.join(FIX, 'lecture.mp3');

  const wav = await extractAudio(file, FIX);
  check('ffmpeg extracts 16 kHz mono WAV', fs.existsSync(wav) && fs.statSync(wav).size > 1000);
  fs.rmSync(wav, { force: true });

  const { segments, durationSec } = await extractVideoSegments(file, FIX);
  check('produces timestamped segments', segments.length > 0, `${segments.length} segments`);
  check('segments have timestamps in seconds',
    segments.every((s) => typeof s.meta.startSec === 'number' && typeof s.meta.endSec === 'number'));
  check('transcript mentions binary search',
    segments.some((s) => /binary search/i.test(s.text)),
    segments.map((s) => s.text).join(' ').slice(0, 100));
  check('duration > 0', durationSec > 0, `${durationSec.toFixed(1)}s`);

  const { chunkSegments } = await import('../dist/services/chunking.service.js');
  const chunks = chunkSegments(segments);
  check('transcript chunks to timestamped chunks', chunks.length > 0, `${chunks.length} chunks`);
}

// ---------------------------------------------------------------- 5. HTTP API
console.log('\n[5] HTTP API — server end-to-end (multipart upload)');
{
  const server = spawn('node', ['dist/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));

  let up = false;
  for (let i = 0; i < 50 && !up; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    up = await fetch(`http://localhost:${PORT}/health`).then((r) => r.ok).catch(() => false);
  }
  check('server boots', up);

  if (up) {
    const post = async (endpoint, file, type) => {
      const form = new FormData();
      form.append('file', new File([fs.readFileSync(file)], path.basename(file), { type }));
      const res = await fetch(`http://localhost:${PORT}/api/ingest/${endpoint}`, { method: 'POST', body: form });
      return { status: res.status, body: await res.json() };
    };

    const textRes = await post('pdf', path.join(FIX, 'text-notes.pdf'), 'application/pdf');
    check('POST /api/ingest/pdf returns chunks', textRes.status === 200 && textRes.body.chunks.length > 0);
    check('pdf chunks carry page metadata', textRes.body.chunks?.[0]?.meta?.page === 1);

    const scanRes = await post('pdf', path.join(FIX, 'scanned-notes.pdf'), 'application/pdf');
    check('POST /api/ingest/pdf handles scanned PDF via OCR',
      scanRes.status === 200 && scanRes.body.stats.ocrUsed === true);

    const mediaRes = await post('video', path.join(FIX, 'lecture.mp3'), 'audio/mpeg');
    check('POST /api/ingest/video transcribes audio', mediaRes.status === 200 && mediaRes.body.chunks.length > 0,
      mediaRes.body.stats ? `duration=${mediaRes.body.stats.durationSec?.toFixed(1)}s` : '');

    const autoRes = await post('', path.join(FIX, 'text-notes.pdf'), 'application/pdf');
    check('POST /api/ingest auto-detects PDF', autoRes.status === 200 && autoRes.body.type === 'pdf');

    const badRes = await post('pdf', path.join(FIX, 'lecture.mp3'), 'audio/mpeg');
    check('rejects wrong file type', badRes.status === 400);

    server.kill();
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
