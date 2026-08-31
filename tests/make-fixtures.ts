#!/usr/bin/env node
/**
 * Creates test fixtures for both pipelines:
 *  - fixtures/text-notes.pdf     : real text PDF  (mupdf path)
 *  - fixtures/scanned-notes.pdf  : image-only PDF (OCR fallback path)
 *  - fixtures/lecture.mp3        : spoken audio   (whisper path)
 *  - fixtures/lecture.mp4        : video wrapper around the audio (ffmpeg path)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
fs.mkdirSync(FIX, { recursive: true });

const TEXT = [
  'Binary Search Notes',
  '',
  'Binary search works on a sorted array. It compares the target value to the',
  'middle element of the array. If they are not equal, the half in which the',
  'target cannot lie is eliminated and the search continues on the remaining half.',
  'Time complexity is O(log n).',
].join('\n');

// ---- 1) Real text PDF: hand-written minimal single-page PDF with Helvetica text ----
function buildTextPdf(text) {
  const lines = text.split('\n');
  const contentLines = lines
    .map((l, i) => `BT /F1 14 Tf 50 ${740 - i * 24} Td (${l.replace(/([()\\\\])/g, '\\\\$1')}) Tj ET`)
    .join('\n');
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[5] = `<< /Length ${contentLines.length} >>\nstream\n${contentLines}\nendstream`;

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

fs.writeFileSync(path.join(FIX, 'text-notes.pdf'), buildTextPdf(TEXT));
console.log('created text-notes.pdf');

// ---- 2) Scanned PDF: render text to PNG via ffmpeg drawtext, then sips -> PDF ----
const png = path.join(FIX, 'scanned-page.png');
const scannedWords = TEXT.replace(/\n/g, ' ');
execSync(
  `ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=white:s=1200x600:d=1" ` +
  `-vf "drawtext=text='${scannedWords.replace(/'/g, "\\'")}':fontcolor=black:fontsize=28:x=40:y=40:line_spacing=12" ` +
  `-frames:v 1 "${png}"`
);
execSync(`sips -s format pdf "${png}" --out "${path.join(FIX, 'scanned-notes.pdf')}" >/dev/null 2>&1`);
console.log('created scanned-notes.pdf');

// ---- 3) Spoken audio via macOS `say`, then wrap as mp3 and mp4 ----
const aiff = path.join(FIX, 'lecture.aiff');
const speech =
  "Today we are going to understand binary search. " +
  "Binary search works on a sorted array. " +
  "We compare the target with the middle element, and eliminate half of the array each step. " +
  "This gives us logarithmic time complexity.";
execSync(`say -o "${aiff}" "${speech}"`);
execSync(`ffmpeg -hide_banner -loglevel error -y -i "${aiff}" "${path.join(FIX, 'lecture.mp3')}"`);
execSync(
  `ffmpeg -hide_banner -loglevel error -y -i "${aiff}" ` +
  `-f lavfi -i "color=c=black:s=640x360" -shortest ` +
  `-c:v libx264 -preset veryfast -c:a aac -shortest "${path.join(FIX, 'lecture.mp4')}"`
);
fs.rmSync(aiff, { force: true });
console.log('created lecture.mp3 and lecture.mp4');
