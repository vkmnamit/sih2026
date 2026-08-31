/**
 * Tests for Reels API & 30-60s Reel Generation
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
const PORT = 4001;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

console.log('\n[Reels Pipeline Tests]');

// 1. Reel service functions
const { getReels, registerVideoFile, safeName, generateReelsForSource } = await import('../dist/services/reel.service.js');

check('safeName replaces special characters', safeName('test lecture (1).mp4') === 'test_lecture_1_.mp4' || safeName('test lecture (1).mp4') === 'test_lecture__1_.mp4');

const lectureAudio = path.join(FIX, 'lecture.mp3');
if (fs.existsSync(lectureAudio)) {
  registerVideoFile('lecture.mp3', lectureAudio);
  const reels = getReels('lecture.mp3');
  check('getReels returns entry for registered video', reels.length > 0 && reels[0].source === 'lecture.mp3');
  check('videoAvailable is true for registered video', reels[0].videoAvailable === true);
}

// 2. Generate reels and verify manifest structure
if (fs.existsSync(lectureAudio)) {
  const count = await generateReelsForSource('lecture.mp3', { targetDurationSec: 30 });
  check('generateReelsForSource produces at least 1 section', count > 0, `${count} sections`);

  const set = getReels('lecture.mp3')[0];
  check('Manifest contains status', Boolean(set.status));
  check('Manifest reels array is populated', set.reels.length > 0);

  const r0 = set.reels[0];
  check('Reel has start & end numbers', typeof r0.start === 'number' && typeof r0.end === 'number');
  check('Reel has duration', typeof r0.duration === 'number' && r0.duration > 0);
  check('Reel has hook title', typeof r0.title === 'string' && r0.title.length > 0);
  check('Reel has video and captions URLs', typeof r0.video === 'string' && typeof r0.captions === 'string');
  check('Reel has takeaways array', Array.isArray(r0.takeaways) && r0.takeaways.length > 0);
  check('SRT caption file exists on disk', fs.existsSync(path.join(__dirname, '..', 'data', r0.captions.replace(/^\//, ''))));
}

// 3. HTTP API Server Test
const server = spawn('node', ['dist/server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let up = false;
for (let i = 0; i < 50 && !up; i += 1) {
  await new Promise((r) => setTimeout(r, 200));
  up = await fetch(`http://localhost:${PORT}/health`).then((r) => r.ok).catch(() => false);
}
check('Server boots for reels tests', up);

if (up) {
  // GET /api/reels
  const res = await fetch(`http://localhost:${PORT}/api/reels`);
  const data = await res.json();
  check('GET /api/reels returns ok', res.status === 200 && data.ok === true && Array.isArray(data.sources));

  // GET /api/reels?source=lecture.mp3
  const singleRes = await fetch(`http://localhost:${PORT}/api/reels?source=lecture.mp3`);
  const singleData = await singleRes.json();
  check('GET /api/reels?source=... returns manifest', singleRes.status === 200 && singleData.source === 'lecture.mp3');
  check('Manifest contains structured takeaways', Array.isArray(singleData.reels?.[0]?.takeaways));

  // Verify static /reels and /reels.html
  const reelsHtmlRes = await fetch(`http://localhost:${PORT}/reels.html`);
  check('reels.html is served statically', reelsHtmlRes.status === 200);

  const reelsJsRes = await fetch(`http://localhost:${PORT}/reels.js`);
  check('reels.js is served statically', reelsJsRes.status === 200);

  // POST /api/reels/generate validation
  const badGen = await fetch(`http://localhost:${PORT}/api/reels/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('POST /api/reels/generate rejects empty source', badGen.status === 400);

  server.kill();
}

console.log(`\n=== Reels Tests: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
