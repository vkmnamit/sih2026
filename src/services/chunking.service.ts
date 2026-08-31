/**
 * Chunking service — shared by BOTH pipelines.
 *
 *   PDF  ──→ MuPDF/OCR ──→ TEXT ──┐
 *                                │
 *   Video ──→ Whisper ──→ TEXT ──┤
 *                                ↓
 *                     chunking (this service)
 *                                ↓
 *                    (embeddings → vector DB → RAG)
 *
 * Splits text into overlapping word-aligned chunks. Metadata attached to a
 * segment (page number, timestamps...) is merged into the produced chunks so a
 * chunk always knows where it came from.
 */
import type { Chunk, Segment } from '../types/ingest.js';

interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

/**
 * Chunk a flat block of text.
 * @param text raw text to chunk
 * @param opts sizing options
 * @param meta metadata merged into every produced chunk
 */
export function chunkText(
  text: string,
  { maxChars = 1200, overlapChars = 150 }: ChunkOptions = {},
  meta: Segment['meta'] = {}
): Chunk[] {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const words = clean.split(' ');
  const chunks: Chunk[] = [];

  let current: string[] = [];
  let currentLen = 0;
  let index = 0;

  const flush = (): void => {
    if (currentLen === 0) return;
    chunks.push({
      id: `chunk_${String(index).padStart(4, '0')}`,
      text: current.join(' '),
      charCount: currentLen,
      meta: { ...meta },
    });
    index += 1;

    // Carry the tail of this chunk as overlap for the next one
    const overlap: string[] = [];
    let overlapLen = 0;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const w = current[i];
      if (overlapLen + w.length + 1 > overlapChars) break;
      overlap.unshift(w);
      overlapLen += w.length + 1;
    }
    current = overlap;
    currentLen = overlapLen;
  };

  for (const word of words) {
    if (currentLen + word.length + 1 > maxChars && currentLen > 0) flush();
    current.push(word);
    currentLen += word.length + 1;
  }
  flush();

  return chunks;
}

/**
 * Chunk an ordered list of already-segmented text pieces (one PDF page or one
 * transcript segment each). Segments are concatenated and every chunk carries
 * the union of the metadata of the segments it covers.
 */
export function chunkSegments(
  segments: Segment[],
  { maxChars = 1200, overlapChars = 150 }: ChunkOptions = {}
): Chunk[] {
  const chunks: Chunk[] = [];
  let buffer: Segment[] = [];
  let bufferLen = 0;
  let index = 0;

  const flush = (): void => {
    if (bufferLen === 0) return;
    const text = buffer.map((s) => s.text).join(' ');
    // Merge metadata of covered segments. Ranges win over single values:
    // a chunk spanning pages 1-3 or seconds 0-14 must record the full range.
    const meta: Segment['meta'] = {};
    for (const seg of buffer) Object.assign(meta, seg.meta);

    const pageNums = buffer
      .map((s) => s.meta.page)
      .filter((v): v is number => typeof v === 'number');
    if (pageNums.length > 0) {
      meta.page = Math.min(...pageNums);
      const pageEnd = Math.max(...pageNums);
      if (pageEnd !== meta.page) meta.pageEnd = pageEnd;
    }

    const starts = buffer
      .map((s) => s.meta.startSec)
      .filter((v): v is number => typeof v === 'number');
    const ends = buffer
      .map((s) => s.meta.endSec)
      .filter((v): v is number => typeof v === 'number');
    if (starts.length > 0) meta.startSec = Math.min(...starts);
    if (ends.length > 0) meta.endSec = Math.max(...ends);

    chunks.push({
      id: `chunk_${String(index).padStart(4, '0')}`,
      text,
      charCount: text.length,
      meta,
    });
    index += 1;

    // Overlap: keep trailing words as a plain-text buffer, re-attaching the
    // metadata of the segment they came from
    const overlapWords = text.slice(Math.max(0, text.length - overlapChars)).split(' ');
    overlapWords.shift(); // drop the partial word at the boundary
    const tailText = overlapWords.join(' ');
    const lastMeta = buffer[buffer.length - 1]?.meta ?? {};
    buffer = tailText ? [{ text: tailText, meta: lastMeta }] : [];
    bufferLen = tailText.length;
  };

  for (const seg of segments) {
    const segText = (seg.text ?? '').replace(/\s+/g, ' ').trim();
    if (!segText) continue;
    if (bufferLen + segText.length + 1 > maxChars && bufferLen > 0) flush();
    buffer.push({ text: segText, meta: seg.meta ?? {} });
    bufferLen += segText.length + 1;
  }
  flush();

  return chunks;
}
