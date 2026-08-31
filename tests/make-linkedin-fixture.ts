#!/usr/bin/env node
/**
 * Realistic-content fixtures:
 *  - linkedin-playbook-30p.pdf  : 30-page text PDF (cover + 9 articles + 20 LinkedIn-style posts)
 *  - linkedin-masterclass.mp3   : ~90s spoken "LinkedIn masterclass" (whisper input)
 *  - linkedin-masterclass.mp4   : same audio wrapped in a video container
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTICLES } from './linkedin-articles.js';
import { POSTS, MASTERCLASS_SCRIPT } from './linkedin-posts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
fs.mkdirSync(FIX, { recursive: true });

function wrap(text, width = 84) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function pageLines(title, paragraphs, tags = []) {
  const lines = [title.toUpperCase(), ''];
  for (const p of paragraphs) lines.push(...wrap(p), '');
  if (tags.length) lines.push(tags.join('  '));
  return lines.slice(0, 28); // hard cap: 28 lines fit on a page
}

// 30 pages: 1 cover + 9 articles + 20 posts
const pages = [];
pages.push(pageLines('The LinkedIn Creator Playbook', [
  'Thirty pages of articles and field-tested posts about building an audience on LinkedIn. Part one covers how the algorithm actually ranks content. Part two is twenty real posts with the hooks, bodies and hashtags that made them work.',
  'Everything in this playbook was learned by posting for two years, failing publicly, and reading more comments than any human probably should.',
]));
ARTICLES.forEach(([t, p1, p2]) => pages.push(pageLines(`Article: ${t}`, [p1, p2])));
POSTS.forEach(([hook, body, tags], i) =>
  pages.push(pageLines(`Post #${i + 1}`, [`Hook: ${hook}`, body], tags)));

if (pages.length !== 30) throw new Error(`expected 30 pages, got ${pages.length}`);

// ------------------------------------------------- minimal multi-page PDF writer
const escapePdf = (s) => s.replace(/([()\\])/g, '\\$1');

function buildMultiPagePdf(pagesLines) {
  const n = pagesLines.length;
  const objects = new Map();
  const kids = [];
  for (let i = 0; i < n; i += 1) {
    const pageObj = 4 + 2 * i;
    const contObj = 5 + 2 * i;
    kids.push(`${pageObj} 0 R`);
    const content = pagesLines[i]
      .map((l, li) => `BT /F1 12 Tf 50 ${740 - li * 26} Td (${escapePdf(l)}) Tj ET`)
      .join('\n');
    objects.set(pageObj, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contObj} 0 R >>`);
    objects.set(contObj, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`);
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let out = '%PDF-1.4\n';
  const offsets = new Map();
  for (let num = 1; num <= 3 + 2 * n; num += 1) {
    offsets.set(num, out.length);
    out += `${num} 0 obj\n${objects.get(num)}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${3 + 2 * n + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= 3 + 2 * n; num += 1) {
    out += `${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${3 + 2 * n + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

fs.writeFileSync(path.join(FIX, 'linkedin-playbook-30p.pdf'), buildMultiPagePdf(pages));
console.log('created linkedin-playbook-30p.pdf (30 pages)');

// ------------------------------------------------- spoken masterclass (video)
const aiff = path.join(FIX, 'linkedin-masterclass.aiff');
execSync(`say -o "${aiff}" "${MASTERCLASS_SCRIPT}"`);
execSync(`ffmpeg -hide_banner -loglevel error -y -i "${aiff}" "${path.join(FIX, 'linkedin-masterclass.mp3')}"`);
execSync(
  `ffmpeg -hide_banner -loglevel error -y -i "${aiff}" ` +
  `-f lavfi -i "color=c=black:s=640x360" -shortest ` +
  `-c:v libx264 -preset veryfast -c:a aac "${path.join(FIX, 'linkedin-masterclass.mp4')}"`
);
fs.rmSync(aiff, { force: true });
console.log('created linkedin-masterclass.mp3 / .mp4');
