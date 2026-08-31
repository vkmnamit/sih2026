/**
 * Realistic-content E2E test:
 *  - POST 30-page "LinkedIn Creator Playbook" PDF  → /api/ingest/pdf
 *  - POST spoken "LinkedIn masterclass" video      → /api/ingest/video
 * Verifies chunking coverage (every PDF page present, timestamps monotonic)
 * and prints sample chunks.
 *
 * Run: npm run build && node tests/run-linkedin-test.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
const PORT = 3995;

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

function post(port, endpoint, file, type) {
  const form = new FormData();
  form.append('file', new File([fs.readFileSync(file)], path.basename(file), { type }));
  return fetch(`http://localhost:${port}/api/ingest/${endpoint}`, { method: 'POST', body: form })
    .then(async (res) => ({ status: res.status, body: await res.json() }));
}

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

// ================================================================ PDF (30 pages)
console.log('\n[PDF] 30-page LinkedIn Creator Playbook → POST /api/ingest/pdf');
{
  const { status, body } = await post(
    PORT, 'pdf', path.join(FIX, 'linkedin-playbook-30p.pdf'), 'application/pdf'
  );
  check('returns 200', status === 200, `status=${status}`);
  check('all 30 pages extracted', body.stats?.pages === 30, `pages=${body.stats?.pages}`);
  check('no OCR needed (text PDF)', body.stats?.ocrUsed === false);
  check('document chunked', body.stats?.chunks >= 10, `${body.stats?.chunks} chunks`);

  const metaPages = new Set();
  for (const c of body.chunks) {
    const start = c.meta.page;
    const end = c.meta.pageEnd ?? c.meta.page;
    if (typeof start === 'number') {
      for (let p = start; p <= (end ?? start); p += 1) metaPages.add(p);
    }
  }
  const allPages = Array.from({ length: 30 }, (_, i) => i + 1);
  const missing = allPages.filter((p) => !metaPages.has(p));
  check('every page number survives into chunk metadata (ranges)', missing.length === 0,
    missing.length ? `missing pages: ${missing.join(',')}` : 'pages 1–30 all present');

  const maxLen = Math.max(...body.chunks.map((c) => c.charCount));
  check('chunks respect max size (~1200 chars)', maxLen <= 1350, `largest=${maxLen} chars`);

  // Content spot checks: cover, one article, one post, last post
  const text = body.chunks.map((c) => c.text).join(' ').toLowerCase();
  check('cover content found', text.includes('linkedin creator playbook'));
  check('article content found', text.includes('3-second hook'));
  check('first post found', text.includes('rejected from 23 jobs'));
  check('last post found', text.includes('industrial pumps'));

  console.log('\n  📄 sample chunks:');
  for (const c of [body.chunks[0], body.chunks[Math.floor(body.chunks.length / 2)], body.chunks.at(-1)]) {
    const range = c.meta.pageEnd ? `pages ${c.meta.page}–${c.meta.pageEnd}` : `page ${c.meta.page}`;
    console.log(`     ${c.id} (${range}, ${c.charCount} chars): ${c.text.slice(0, 110)}…`);
  }
}

// ================================================================ VIDEO
console.log('\n[VIDEO] LinkedIn masterclass → POST /api/ingest/video');
{
  const { status, body } = await post(
    PORT, 'video', path.join(FIX, 'linkedin-masterclass.mp4'), 'video/mp4'
  );
  check('returns 200', status === 200, `status=${status}`);
  check('transcribed into segments', body.stats?.segments >= 5, `${body.stats?.segments} segments`);
  check('duration over one minute', body.stats?.durationSec > 60,
    `${body.stats?.durationSec?.toFixed(1)}s`);
  check('chunked', body.stats?.chunks >= 1, `${body.stats?.chunks} chunks`);

  const secs = body.chunks.flatMap((c) => [c.meta.startSec, c.meta.endSec]);
  check('chunks carry timestamps', secs.every((s) => typeof s === 'number'));
  check('timestamps start at zero', body.chunks[0]?.meta?.startSec === 0);
  check('timestamps cover the whole duration',
    body.chunks.at(-1)?.meta?.endSec >= body.stats.durationSec - 1);

  const text = body.chunks.map((c) => c.text).join(' ');
  check('transcript covers hook topic', /hook/i.test(text));
  check('transcript covers analytics topic', /analytics|impressions/i.test(text));

  console.log('\n  🎬 sample transcript chunks:');
  for (const c of body.chunks) {
    console.log(`     ${c.id} [${c.meta.startSec.toFixed(1)}s → ${c.meta.endSec.toFixed(1)}s]: ${c.text.slice(0, 100)}…`);
  }
}

server.kill();
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
