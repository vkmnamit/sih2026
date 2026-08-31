/**
 * Reel service — turns an uploaded video into vertical (9:16) reels (30–60s clips)
 * with AI sectioning, hook titles, bullet takeaways, and progressive background rendering.
 *
 * Architecture:
 *   Uploaded Video (stored in uploads/<source>)
 *        ↓
 *   Whisper Timestamped Transcript
 *        ↓
 *   AI Sectioning (sentence & topic boundaries → 30–60s sections)
 *        ↓
 *   Hook Titles + Captions (.srt) + Takeaways ([...])
 *        ↓
 *   Reel Manifest Created Immediately (status: "processing")
 *        ↓
 *   Background FFmpeg Progressive Rendering (clip by clip: "pending" → "ready")
 *        ↓
 *   Manifest Updated (status: "completed")
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { getDocsBySource, search } from './vector-store.service.js';
import { embedText, embedTexts } from './embedding.service.js';
import { chatComplete } from './llm.service.js';
import type { ReelInfo, ReelSet } from '../types/ingest.js';

const MANIFEST_PATH = path.join(config.reelsDir, 'manifest.json');

/** Sources with an active in-process generation (prevents duplicate runs). */
const activeGenerations = new Set<string>();

interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

interface SectionWindow {
  start: number;
  end: number;
  duration: number;
  text: string;
  cues: SubtitleCue[];
}

interface ManifestEntry {
  videoPath: string;
  durationSec?: number;
  status: 'completed' | 'processing' | 'generating' | 'ready' | 'idle' | 'failed';
  error?: string;
  generatedAt: string;
  reels: ReelInfo[];
}

type Manifest = Record<string, ManifestEntry>;

import { normalizeFilename } from '../middleware/upload.middleware.js';

// ------------------------------------------------------------------ helpers

/** Filesystem-safe version of a source name (used for reel directories). */
export function safeName(source: string): string {
  const norm = normalizeFilename(source);
  return norm.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function loadManifest(): Manifest {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

function persistManifest(manifest: Manifest): void {
  const tmp = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, MANIFEST_PATH);
}

/** True when the original video for a source exists on disk. */
export function hasVideoFile(source: string): boolean {
  const norm = normalizeFilename(source);
  if (fs.existsSync(path.join(config.uploadDir, source)) || fs.existsSync(path.join(config.uploadDir, norm))) return true;
  try {
    const files = fs.readdirSync(config.uploadDir);
    return files.some((f) => normalizeFilename(f) === norm || f === source);
  } catch {
    return false;
  }
}

/** Get source video path if available. */
export function getVideoPath(source: string): string | null {
  const manifest = loadManifest();
  const norm = normalizeFilename(source);
  const entryKey = Object.keys(manifest).find((k) => normalizeFilename(k) === norm || k === source);
  const entry = entryKey ? manifest[entryKey] : undefined;
  if (entry && fs.existsSync(entry.videoPath)) return entry.videoPath;
  if (fs.existsSync(path.join(config.uploadDir, source))) return path.join(config.uploadDir, source);
  if (fs.existsSync(path.join(config.uploadDir, norm))) return path.join(config.uploadDir, norm);
  try {
    const files = fs.readdirSync(config.uploadDir);
    const found = files.find((f) => normalizeFilename(f) === norm);
    if (found) return path.join(config.uploadDir, found);
  } catch {}
  return null;
}

/** ffprobe the container duration (seconds). Returns 0 when unavailable. */
export function probeDurationSec(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('error', () => resolve(0));
    proc.on('close', (code) => {
      const n = Number.parseFloat(out.trim());
      resolve(code === 0 && Number.isFinite(n) ? n : 0);
    });
  });
}

/** Run one ffmpeg render, rejecting with captured stderr on failure. */
function runFfmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 1: LLM Topic Boundary Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats the Whisper cues as a readable timestamped transcript for the LLM.
 * Example line: "[00:18] Binary search works by checking the middle element..."
 */
function formatTranscriptForLLM(cues: SubtitleCue[]): string {
  return cues.map((c) => {
    const t = Math.max(0, c.startSec);
    const m = String(Math.floor(t / 60)).padStart(2, '0');
    const s = String(Math.floor(t % 60)).padStart(2, '0');
    return `[${m}:${s}] ${c.text.trim()}`;
  }).join('\n');
}

/** Lecture cue words that signal a topic transition. */
const TOPIC_CUE_WORDS = [
  'now let', "let's now", "let's talk", 'next,', 'moving on', 'moving to',
  'for example', 'let me show', 'let me explain', 'so the key', 'in summary',
  'finally,', 'importantly,', 'to summarize', 'the important', 'the key idea',
  'step one', 'step two', 'step three', 'first,', 'second,', 'third,',
];

/** Returns true if text starts with a topic transition cue. */
function hasCueWord(text: string): boolean {
  const lower = text.toLowerCase();
  return TOPIC_CUE_WORDS.some((cue) => lower.startsWith(cue) || lower.includes(` ${cue}`));
}

/**
 * STAGE 1: Send the full timestamped transcript to the LLM and ask it to
 * identify topic boundaries. Returns raw LLM topic sections with timestamps.
 *
 * Fallback: if LLM is unavailable or response is malformed, returns null.
 */
async function llmTopicSegmentation(
  cues: SubtitleCue[],
  totalDurationSec: number,
  source: string,
): Promise<Array<{ title: string; startSec: number; endSec: number }> | null> {
  if (cues.length === 0) return null;

  const transcriptText = formatTranscriptForLLM(cues);
  const totalMin = Math.round(totalDurationSec / 60);

  // For very long videos (>30 min), we process in overlapping 10-min windows
  // then merge the boundary results. For typical lecture lengths (≤30 min), use one call.
  const chunkCues = totalDurationSec > 1800
    ? chunkCuesIntoWindows(cues, 600, 60) // 10-min windows, 60s overlap
    : [cues];

  const allBoundaries: Array<{ title: string; startSec: number; endSec: number }> = [];

  for (const window of chunkCues) {
    const windowText = formatTranscriptForLLM(window);
    const windowDuration = (window[window.length - 1]?.endSec ?? 0) - (window[0]?.startSec ?? 0);
    const expectedSections = Math.max(2, Math.round(windowDuration / 40));

    try {
      const raw = await chatComplete(
        [
          {
            role: 'system',
            content:
              'You are an expert educational video editor analyzing a lecture transcript.\n' +
              'Your task: identify meaningful TOPIC BOUNDARIES where the speaker transitions to a new concept.\n' +
              '\nRules:\n' +
              '- Each section should cover ONE coherent idea (like "What is Binary Search", "Binary Search Example", "Time Complexity")\n' +
              '- Use the EXACT timestamps from the transcript (MM:SS format shown in brackets)\n' +
              '- Look for transition signals: "now let\'s", "for example", "next", "moving on", "importantly", "in summary"\n' +
              '- The first section always starts at the first timestamp\n' +
              '- The last section always ends at the last timestamp\n' +
              `- Aim for roughly ${expectedSections} sections\n` +
              '\nRespond with ONLY a JSON array. No explanation. No markdown. Example:\n' +
              '[{"title":"What is Binary Search","startSec":0,"endSec":52},{"title":"Binary Search Example","startSec":52,"endSec":125}]',
          },
          {
            role: 'user',
            content: `Source: ${source}\nTotal duration: ~${totalMin} minutes\n\nTranscript:\n${windowText}`,
          },
        ],
        { temperature: 0.2, maxTokens: 2000 }
      );

      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]) as Array<{ title?: string; startSec?: number; endSec?: number }>;
          const valid = parsed.filter(
            (s) => typeof s.title === 'string' && typeof s.startSec === 'number' && typeof s.endSec === 'number'
              && s.endSec > s.startSec
          );
          if (valid.length >= 1) {
            allBoundaries.push(...(valid as Array<{ title: string; startSec: number; endSec: number }>));
          } else {
            console.warn(`[reels] LLM segmentation: response JSON had no valid boundaries for "${source}"`);
          }
        } catch (parseErr) {
          console.warn(`[reels] LLM segmentation: JSON parse failed for "${source}":`, (parseErr as Error).message);
        }
      } else {
        console.warn(`[reels] LLM segmentation: no JSON array in LLM response for "${source}" (first 200 chars: ${raw.slice(0, 200)})`);
      }
    } catch (err) {
      console.warn('[reels] LLM topic segmentation call failed:', (err as Error).message);
    }
  }

  // Deduplicate overlapping boundaries from chunked windows
  if (allBoundaries.length === 0) return null;
  const merged = deduplicateBoundaries(allBoundaries);
  return merged.length >= 1 ? merged : null;
}

/** Split cues into overlapping time windows (for very long videos). */
function chunkCuesIntoWindows(cues: SubtitleCue[], windowSec: number, overlapSec: number): SubtitleCue[][] {
  if (cues.length === 0) return [];
  const windows: SubtitleCue[][] = [];
  const startTime = cues[0].startSec;
  let windowStart = startTime;

  while (true) {
    const windowEnd = windowStart + windowSec;
    const windowCues = cues.filter((c) => c.startSec >= windowStart && c.startSec < windowEnd);
    if (windowCues.length > 0) windows.push(windowCues);
    if (windowEnd >= cues[cues.length - 1].endSec) break;
    windowStart = windowEnd - overlapSec;
  }
  return windows;
}

/** Remove duplicate/overlapping sections from chunked window results. */
function deduplicateBoundaries(
  sections: Array<{ title: string; startSec: number; endSec: number }>
): Array<{ title: string; startSec: number; endSec: number }> {
  const sorted = [...sections].sort((a, b) => a.startSec - b.startSec);
  const result: typeof sorted = [];
  for (const sec of sorted) {
    const last = result[result.length - 1];
    if (!last || sec.startSec >= last.endSec - 5) {
      result.push(sec);
    }
    // If overlap: keep the one with a later endSec (wider coverage)
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 2: 30–60s Constraint Enforcement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STAGE 2: Takes the LLM topic boundaries and enforces the 30–60s window.
 * - Sections < minSec: merged with the nearest neighbour
 * - Sections > maxSec: split at the nearest sentence boundary ≥ midpoint
 * - Always snaps timestamps to actual Whisper cue boundaries
 */
function enforceWindowConstraints(
  topics: Array<{ title: string; startSec: number; endSec: number }>,
  allCues: SubtitleCue[],
  minSec = 30,
  maxSec = 60,
): SectionWindow[] {
  // Snap topic boundary times to nearest Whisper cue
  let snapped = topics.map((t) => ({
    ...t,
    startSec: snapToCue(t.startSec, allCues, 'start'),
    endSec: snapToCue(t.endSec, allCues, 'end'),
  }));

  // Rebuild cue lists per section
  let windows: SectionWindow[] = snapped.map((t) => ({
    start: t.startSec,
    end: t.endSec,
    duration: t.endSec - t.startSec,
    text: allCues
      .filter((c) => c.startSec >= t.startSec && c.endSec <= t.endSec + 0.5)
      .map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim(),
    cues: allCues.filter((c) => c.startSec >= t.startSec && c.endSec <= t.endSec + 0.5),
    llmTitle: t.title,
  } as SectionWindow & { llmTitle: string }));

  // MERGE: sections too short
  let didMerge = true;
  while (didMerge) {
    didMerge = false;
    for (let i = 0; i < windows.length; i++) {
      if (windows[i].duration < minSec && windows.length > 1) {
        // Very short stubs (< 15s) merge forward into the NEXT topic;
        // otherwise merge with the nearest (previous) neighbour.
        let mergeTarget: number;
        if (windows[i].duration < 15 && i < windows.length - 1) mergeTarget = i + 1;
        else mergeTarget = i === 0 ? 1 : i - 1;
        const a = windows[Math.min(i, mergeTarget)];
        const b = windows[Math.max(i, mergeTarget)];
        const merged: SectionWindow & { llmTitle: string } = {
          start: a.start,
          end: b.end,
          duration: b.end - a.start,
          text: `${a.text} ${b.text}`.trim(),
          cues: [...a.cues, ...b.cues],
          llmTitle: (a as SectionWindow & { llmTitle: string }).llmTitle ||
                    (b as SectionWindow & { llmTitle: string }).llmTitle,
        };
        windows.splice(Math.min(i, mergeTarget), 2, merged);
        didMerge = true;
        break;
      }
    }
  }

  // SPLIT: sections too long — split at sentence boundary nearest to midpoint
  const result: Array<SectionWindow & { llmTitle: string }> = [];
  for (const win of windows as Array<SectionWindow & { llmTitle: string }>) {
    if (win.duration <= maxSec) {
      result.push(win);
    } else {
      // Recursively split overlong sections
      result.push(...splitOverlong(win, allCues, maxSec, minSec));
    }
  }

  // Round timestamps
  return result.map((w) => ({
    ...w,
    start: Math.round(w.start * 100) / 100,
    end: Math.round(w.end * 100) / 100,
    duration: Math.round(w.duration * 10) / 10,
  }));
}

/** Snap a target time to the nearest Whisper cue boundary. */
function snapToCue(timeSec: number, cues: SubtitleCue[], edge: 'start' | 'end'): number {
  if (cues.length === 0) return timeSec;
  let best = cues[0];
  let bestDist = Math.abs(timeSec - (edge === 'start' ? cues[0].startSec : cues[0].endSec));
  for (const c of cues) {
    const dist = Math.abs(timeSec - (edge === 'start' ? c.startSec : c.endSec));
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return edge === 'start' ? best.startSec : best.endSec;
}

/** Split an overlong section at the sentence boundary nearest the midpoint. */
function splitOverlong(
  win: SectionWindow & { llmTitle: string },
  allCues: SubtitleCue[],
  maxSec: number,
  minSec: number,
): Array<SectionWindow & { llmTitle: string }> {
  if (win.duration <= maxSec) return [win];

  // A single long Whisper cue (chunker merged several sentences into one
  // chunk) cannot be split by cue boundaries — synthesize sub-cues by
  // splitting the text into sentences with time allocated proportionally.
  if (win.cues.length < 2) {
    const sentences = win.text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length < 2) return [win];
    const totalChars = sentences.reduce((s, x) => s + x.length, 0);
    let t = win.start;
    const subCues: SubtitleCue[] = sentences.map((s) => {
      const d = (s.length / totalChars) * win.duration;
      const cue = { startSec: Math.round(t * 100) / 100, endSec: Math.round((t + d) * 100) / 100, text: s };
      t += d;
      return cue;
    });
    return splitOverlong({ ...win, cues: subCues }, allCues, maxSec, minSec);
  }

  const mid = win.start + win.duration / 2;
  // Find sentence-ending cue closest to midpoint
  let splitCue = win.cues[Math.floor(win.cues.length / 2)];
  let bestDist = Infinity;
  for (const c of win.cues) {
    if (/[.!?]$/.test(c.text) || hasCueWord(c.text)) {
      const dist = Math.abs(c.endSec - mid);
      if (dist < bestDist && c.endSec - win.start >= minSec && win.end - c.endSec >= minSec) {
        bestDist = dist;
        splitCue = c;
      }
    }
  }

  const splitAt = splitCue.endSec;
  const cuesA = win.cues.filter((c) => c.endSec <= splitAt);
  const cuesB = win.cues.filter((c) => c.startSec >= splitAt);
  if (cuesA.length === 0 || cuesB.length === 0) return [win];

  const partA: SectionWindow & { llmTitle: string } = {
    start: win.start, end: splitAt, duration: splitAt - win.start,
    text: cuesA.map((c) => c.text).join(' ').trim(), cues: cuesA,
    llmTitle: win.llmTitle,
  };
  const partB: SectionWindow & { llmTitle: string } = {
    start: splitAt, end: win.end, duration: win.end - splitAt,
    text: cuesB.map((c) => c.text).join(' ').trim(), cues: cuesB,
    llmTitle: win.llmTitle,
  };

  // Recurse in case parts are still too long
  return [
    ...splitOverlong(partA, allCues, maxSec, minSec),
    ...splitOverlong(partB, allCues, maxSec, minSec),
  ];
}

/**
 * Sentence-boundary heuristic fallback (used when LLM is unavailable).
 * Groups Whisper cues into 30–60s windows at sentence endings.
 */
function heuristicSegmentation(
  docs: { text: string; meta: Record<string, unknown> }[],
  targetDuration = 45,
  minDuration = 30,
  maxDuration = 60
): SectionWindow[] | null {
  const segs: SubtitleCue[] = docs
    .map((d) => ({
      startSec: typeof d.meta.startSec === 'number' ? d.meta.startSec : NaN,
      endSec: typeof d.meta.endSec === 'number' ? d.meta.endSec : NaN,
      text: d.text.trim(),
    }))
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  if (segs.length === 0) return null;

  const sections: SectionWindow[] = [];
  let curCues: SubtitleCue[] = [];
  let winStart = segs[0].startSec;

  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    curCues.push(seg);
    const curLen = seg.endSec - winStart;
    const isSentenceEnd = /[.!?]$/.test(seg.text) || hasCueWord(seg.text);
    const isLast = i === segs.length - 1;

    const shouldClose =
      (curLen >= targetDuration && isSentenceEnd) ||
      curLen >= maxDuration ||
      (isLast && curLen >= minDuration);

    if (shouldClose) {
      const fullText = curCues.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
      const start = Math.round(winStart * 100) / 100;
      const end = Math.round(seg.endSec * 100) / 100;
      sections.push({ start, end, duration: Math.round((end - start) * 10) / 10, text: fullText, cues: [...curCues] });
      curCues = [];
      if (i + 1 < segs.length) winStart = segs[i + 1].startSec;
    }
  }

  if (curCues.length > 0) {
    const lastSeg = curCues[curCues.length - 1];
    const fullText = curCues.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
    if (sections.length > 0 && lastSeg.endSec - sections[sections.length - 1].start <= maxDuration + 15) {
      const last = sections[sections.length - 1];
      last.end = Math.round(lastSeg.endSec * 100) / 100;
      last.duration = Math.round((last.end - last.start) * 10) / 10;
      last.text += ` ${fullText}`;
      last.cues.push(...curCues);
    } else {
      const start = Math.round(winStart * 100) / 100;
      const end = Math.round(lastSeg.endSec * 100) / 100;
      sections.push({ start, end, duration: Math.round((end - start) * 10) / 10, text: fullText, cues: curCues });
    }
  }

  return sections.length > 0 ? sections : null;
}

/** Evenly spaced fallback windows (30-60s) when no transcript is available. */
function buildEvenSections(durationSec: number, targetSec = 45): SectionWindow[] {
  const count = Math.max(1, Math.ceil(durationSec / targetSec));
  const clipLen = Math.min(60, Math.max(25, durationSec / count));
  const step = count > 1 ? (durationSec - clipLen) / (count - 1) : 0;
  const sections: SectionWindow[] = [];

  for (let i = 0; i < count; i += 1) {
    const start = Math.round(Math.min(Math.max(0, i * step), Math.max(0, durationSec - 2)) * 10) / 10;
    const end = Math.round(Math.min(durationSec, start + clipLen) * 10) / 10;
    sections.push({
      start,
      end,
      duration: Math.round((end - start) * 10) / 10,
      text: '',
      cues: [],
    });
  }
  return sections;
}

/** Write a formatted .srt subtitle file with clean timestamps. */
function writeSrt(
  filePath: string,
  cues: SubtitleCue[],
  offsetSec: number
): void {
  const ts = (s: number) => {
    const t = Math.max(0, s - offsetSec);
    const h = String(Math.floor(t / 3600)).padStart(2, '0');
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const sec = String(Math.floor(t % 60)).padStart(2, '0');
    const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${sec},${ms}`;
  };

  const body = cues.map((c, i) =>
    `${i + 1}\n${ts(c.startSec)} --> ${ts(c.endSec)}\n${c.text.replace(/\s+/g, ' ').trim()}\n`
  ).join('\n');
  fs.writeFileSync(filePath, body, 'utf8');
}

/** Deterministic fallback hook title. */
function fallbackTitle(text: string, index = 0): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return `Key Highlight #${index + 1}`;
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] || clean;
  return firstSentence.length > 55 ? `${firstSentence.slice(0, 52)}…` : firstSentence;
}

/** Fallback bullet takeaways. */
function fallbackTakeaways(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  if (sentences.length > 0) return sentences.slice(0, 3);
  return ['Key concept explained in this video segment.'];
}

/**
 * Retrieve RAG context for a section — top-K similar passages from the same source.
 * Used to enrich takeaway generation with related content from the lecture.
 */
async function ragContextForSection(
  sectionText: string,
  source: string,
  topK = 3
): Promise<string> {
  try {
    const vec = await embedText(sectionText.slice(0, 512));
    const hits = search(vec, topK + 2, source);
    // Exclude passages that are too similar to the section itself (overlap > 60%)
    const context = hits
      .filter((h) => {
        const overlap = sectionText.toLowerCase().includes(h.doc.text.toLowerCase().slice(0, 30));
        return !overlap;
      })
      .slice(0, topK)
      .map((h) => h.doc.text.trim())
      .join('\n\n');
    return context;
  } catch {
    return '';
  }
}

/**
 * Generate Bullet Takeaways + 1-Sentence Summary via LLM, RAG-enriched.
 *
 * @param sectionText - the raw Whisper transcript for this section
 * @param source      - the source filename (for RAG filter)
 * @param index       - section index (for fallback titles)
 * @param llmTitle    - pre-chosen topic title from Stage 1 LLM (skip title re-generation)
 */
async function generateReelMeta(
  sectionText: string,
  source: string,
  index: number,
  llmTitle?: string,
): Promise<{ title: string; takeaways: string[]; summary: string }> {
  const fbTitle = llmTitle?.trim() || fallbackTitle(sectionText, index);
  const fbTakeaways = fallbackTakeaways(sectionText);
  const cleanText = sectionText.replace(/\s+/g, ' ').trim();

  if (!cleanText) {
    return { title: fbTitle, takeaways: fbTakeaways, summary: 'Key video segment highlight.' };
  }

  // RAG: retrieve related passages from the same lecture
  const ragContext = await ragContextForSection(cleanText, source);
  const contextBlock = ragContext
    ? `\n\nRelated context from the same lecture:\n${ragContext}`
    : '';

  try {
    const raw = await chatComplete(
      [
        {
          role: 'system',
          content:
            'You are an AI educational video editor. Given a transcript excerpt and optional related context, ' +
            'generate 2–3 concise bullet takeaways that a student should remember, and a 1-sentence summary. ' +
            'The title is already decided — DO NOT generate a title.\n' +
            'Respond with ONLY JSON in this exact shape (no markdown, no extra text):\n' +
            '{"takeaways": ["...", "..."], "summary": "..."}',
        },
        {
          role: 'user',
          content: `Source: ${source}\nSection: ${fbTitle}\n\nTranscript:\n${cleanText.slice(0, 1000)}${contextBlock}`,
        },
      ],
      { temperature: 0.3, maxTokens: 300 }
    );

    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { takeaways?: string[]; summary?: string };
      return {
        title: fbTitle,
        takeaways: Array.isArray(parsed.takeaways) && parsed.takeaways.length > 0
          ? parsed.takeaways.map((t) => String(t).trim()).filter(Boolean).slice(0, 4)
          : fbTakeaways,
        summary: (parsed.summary || '').trim() || fbTakeaways[0] || 'Key takeaway.',
      };
    }
    return { title: fbTitle, takeaways: fbTakeaways, summary: fbTakeaways[0] };
  } catch {
    return { title: fbTitle, takeaways: fbTakeaways, summary: fbTakeaways[0] };
  }
}

/** Probe if media file contains a video stream */
function hasVideoStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => {
      resolve(code === 0 && out.trim() === 'video');
    });
  });
}

/** Render ONE 9:16 vertical reel using FFmpeg. */
async function renderReel(
  videoPath: string,
  outDir: string,
  fileBase: string,
  srtRelName: string,
  sec: SectionWindow,
  hasCaptions: boolean
): Promise<void> {
  const { reelWidth: W, reelHeight: H } = config;
  const clipDuration = Math.max(1, sec.end - sec.start);
  const isVideo = await hasVideoStream(videoPath);

  const filters = isVideo
    ? [
        '[0:v]split=2[bg][fg]',
        `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:5[bgb]`,
        `[fg]scale=${W}:-2[fgs]`,
        '[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v0]',
        hasCaptions
          ? `[v0]subtitles=${srtRelName}:force_style='FontName=Arial,Fontsize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=60'[vout]`
          : '[v0]null[vout]',
      ]
    : [
        `color=c=#0b0e17:s=${W}x${H}:r=25:d=${clipDuration}[v0]`,
        hasCaptions
          ? `[v0]subtitles=${srtRelName}:force_style='FontName=Arial,Fontsize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=120'[vout]`
          : '[v0]null[vout]',
      ];

  const ffmpegArgs = [
    '-ss', String(sec.start),
    '-t', String(clipDuration),
    '-i', videoPath,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    `${fileBase}.mp4`,
  ];

  await runFfmpeg(ffmpegArgs, outDir);
}

// ──────────────────────────────── interest-based personalized reels ──────────

interface RankedSection {
  index: number;
  score: number;
}

/**
 * Rank a source's semantic sections against a student's interest profile.
 *
 * The content AI decides *what is taught* in each section (Stage 1 titles +
 * takeaways + transcript); this scorer decides *which sections are relevant
 * to this student*. Future ML recommenders can replace the scoring body —
 * the interface (sections + interests → ranked indexes) stays the same.
 *
 * score = 0.85 · max cosine(interest, section) + 0.15 · keyword overlap
 */
async function rankSectionsByInterest(
  sections: ReelInfo[],
  interests: string[]
): Promise<RankedSection[]> {
  const clean = interests.map((i) => i.trim()).filter(Boolean);
  if (sections.length === 0) return [];
  if (clean.length === 0) {
    return sections.map((_, i) => ({ index: i, score: 0.5 }));
  }

  const sectionTexts = sections.map(
    (r) => `${r.title}. ${(r.takeaways ?? []).join(' ')} ${r.transcript ?? ''}`.slice(0, 1200)
  );
  const vectors = await embedTexts([...clean, ...sectionTexts]);
  const interestVecs = vectors.slice(0, clean.length);
  const sectionVecs = vectors.slice(clean.length);

  return sectionVecs.map((sv, i) => {
    let bestCos = -1;
    for (const iv of interestVecs) {
      let dot = 0;
      const dims = Math.min(iv.length, sv.length);
      for (let d = 0; d < dims; d += 1) dot += iv[d] * sv[d];
      if (dot > bestCos) bestCos = dot;
    }
    const hay = `${sections[i].title} ${sections[i].transcript}`.toLowerCase();
    let kwHits = 0;
    for (const interest of clean) {
      const words = interest.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
      if (words.some((w) => hay.includes(w))) kwHits += 1;
    }
    const kwScore = kwHits / clean.length;
    return { index: i, score: Math.max(0, Math.min(1, 0.85 * bestCos + 0.15 * kwScore)) };
  });
}

export interface PersonalizeOptions {
  /** Total stitched reel length cap in seconds (default 90) */
  maxTotalSec?: number;
  /** Per-topic excerpt cap in seconds (default 40) */
  maxSegmentSec?: number;
}

/**
 * Build ONE personalized "For You" reel that stitches the most relevant
 * topic excerpts of a lecture for a given interest profile.
 *
 *   student interests → rank semantic sections → pick timestamp ranges
 *   → render each excerpt 9:16 → FFmpeg concat → 🎬 single MP4
 *
 * The original video is never physically pre-cut; only timestamp ranges
 * are rendered at request time.
 */
export async function generatePersonalizedReel(
  source: string,
  interests: string[],
  options: PersonalizeOptions = {}
): Promise<{ reelId: string; sectionsUsed: number; totalSec: number } | null> {
  const manifest = loadManifest();
  const entryKey = Object.keys(manifest).find((k) => k === source || safeName(k) === safeName(source));
  if (!entryKey) return null;
  const entry = manifest[entryKey];
  if (!entry || entry.reels.length === 0) return null;
  const videoPath = entry.videoPath;
  if (!fs.existsSync(videoPath)) return null;

  const safe = safeName(entryKey);
  const outDir = path.join(config.reelsDir, safe);
  fs.mkdirSync(outDir, { recursive: true });

  const maxTotalSec = options.maxTotalSec ?? 90;
  const maxSegmentSec = options.maxSegmentSec ?? 40;

  // 1. Rank the base (non-personalized) sections against the interest profile
  const baseReels = entry.reels.filter((r) => !r.personalized);
  const ranked = await rankSectionsByInterest(baseReels, interests);
  ranked.sort((a, b) => b.score - a.score);

  // 2. Greedily pick the best excerpts until the length cap is reached.
  //    Each excerpt is trimmed at the nearest cue boundary (never mid-sentence).
  const picked: Array<{ start: number; end: number; title: string; score: number; cues: SubtitleCue[]; text: string }> = [];
  let totalSec = 0;

  for (const { index, score } of ranked) {
    const r = baseReels[index];
    const cues: SubtitleCue[] = (r.cues ?? []).filter(
      (c) => c.endSec > r.start && c.startSec < r.end
    );
    let segEnd = Math.min(r.end, r.start + maxSegmentSec);
    if (cues.length > 0) {
      const cue = cues.find((c) => c.endSec >= segEnd) ?? cues[cues.length - 1];
      segEnd = Math.min(r.end, Math.max(r.start + 5, cue.endSec));
    }
    const dur = segEnd - r.start;
    if (dur < 5) continue;
    if (picked.length > 0 && totalSec + dur > maxTotalSec) continue;

    picked.push({
      start: r.start,
      end: segEnd,
      title: r.title,
      score,
      cues: cues.length > 0 ? cues : [{ startSec: r.start, endSec: segEnd, text: r.transcript }],
      text: r.transcript,
    });
    totalSec += dur;
    if (totalSec >= maxTotalSec * 0.95) break;
  }
  if (picked.length === 0) return null;

  // 3. Register the personalized reel in the manifest immediately so the
  //    frontend can show a ⏳ card while FFmpeg stitches the segments.
  const ts = Date.now();
  const fileBase = `for_you_${ts}`;
  const label = interests.filter(Boolean).slice(0, 3).join(' · ') || 'your interests';
  const reel: ReelInfo = {
    id: `${safe}#${fileBase}`,
    source: entryKey,
    start: 0,
    end: totalSec,
    duration: totalSec,
    startSec: 0,
    endSec: totalSec,
    durationSec: totalSec,
    title: `✨ For You: ${label}`,
    video: `/reels/${safe}/${fileBase}.mp4`,
    fileUrl: `/reels/${safe}/${fileBase}.mp4`,
    captions: `/reels/${safe}/${fileBase}.srt`,
    transcript: picked.map((p) => `— ${p.title} —\n${p.text}`).join('\n\n'),
    takeaways: picked
      .filter((p) => p.text.trim())
      .map((p) => `${p.title}: ${p.text.split(/(?<=[.!?])\s/)[0]}`)
      .slice(0, 6),
    summary: `Personalized cut of "${entryKey}" stitched from ${picked.length} relevant topics for: ${label}.`,
    status: 'processing',
    cues: [],
    personalized: true,
    interests: interests.filter(Boolean),
    segments: picked.map((p) => ({ start: p.start, end: p.end, title: p.title, score: Number(p.score.toFixed(3)) })),
    generatedAt: new Date().toISOString(),
  };
  entry.reels.unshift(reel);
  persistManifest(manifest);

  // 4. Background: render each excerpt, concat, build merged SRT, cleanup.
  void (async () => {
    try {
      const segFiles: string[] = [];
      const mergedCues: SubtitleCue[] = [];
      let offset = 0;

      for (let i = 0; i < picked.length; i += 1) {
        const seg = picked[i];
        const segBase = `${fileBase}_seg${String(i + 1).padStart(2, '0')}`;
        const segSrtRel = `${segBase}.srt`;
        writeSrt(path.join(outDir, segSrtRel), seg.cues, seg.start);

        const win: SectionWindow = {
          start: seg.start,
          end: seg.end,
          duration: seg.end - seg.start,
          text: seg.text,
          cues: seg.cues,
        };
        await renderReel(videoPath, outDir, segBase, segSrtRel, win, seg.text.trim().length > 0);
        segFiles.push(`${segBase}.mp4`);

        for (const c of seg.cues) {
          mergedCues.push({
            startSec: Math.max(0, offset + (c.startSec - seg.start)),
            endSec: Math.max(0.5, offset + (c.endSec - seg.start)),
            text: c.text,
          });
        }
        offset += seg.end - seg.start;
        console.log(`[reels] personalized segment ${i + 1}/${picked.length} rendered (${seg.end - seg.start}s)`);
      }

      // Concat the excerpts (identical codec settings → stream copy)
      const listPath = path.join(outDir, `${fileBase}.txt`);
      fs.writeFileSync(listPath, segFiles.map((f) => `file '${f}'`).join('\n'), 'utf8');
      await runFfmpeg(
        ['-f', 'concat', '-safe', '0', '-i', `${fileBase}.txt`, '-c', 'copy', '-movflags', '+faststart', `${fileBase}.mp4`],
        outDir
      );

      writeSrt(path.join(outDir, `${fileBase}.srt`), mergedCues, 0);

      // Cleanup temp segment files
      for (const f of segFiles) {
        try { fs.unlinkSync(path.join(outDir, f)); } catch { /* ignore */ }
        try { fs.unlinkSync(path.join(outDir, f.replace(/\.mp4$/, '.srt'))); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(listPath); } catch { /* ignore */ }

      reel.status = 'ready';
      console.log(`[reels] personalized reel ready: ${reel.video} (${Math.round(totalSec)}s, ${picked.length} topics)`);
    } catch (err) {
      console.error('[reels] personalized render failed:', (err as Error).message);
      reel.status = 'failed';
      reel.error = (err as Error).message;
    }

    const live = loadManifest();
    const liveEntry = live[entryKey];
    if (liveEntry) {
      const idx = liveEntry.reels.findIndex((r) => r.id === reel.id);
      if (idx >= 0) liveEntry.reels[idx] = reel;
      else liveEntry.reels.unshift(reel);
      persistManifest(live);
    }
  })();

  return { reelId: reel.id, sectionsUsed: picked.length, totalSec };
}

// ------------------------------------------------------------------ public API

export function registerVideoFile(source: string, videoPath: string): void {
  const manifest = loadManifest();
  const entry = manifest[source];
  if (!entry) {
    manifest[source] = {
      videoPath,
      status: 'idle',
      generatedAt: '',
      reels: [],
    };
  } else {
    entry.videoPath = videoPath;
  }
  persistManifest(manifest);
}

export interface GenerateReelsOptions {
  targetDurationSec?: number;
}

/**
 * 1. Determines AI 30–60s sections immediately.
 * 2. Writes full manifest with status "processing" and generates .srt caption files.
 * 3. Asynchronously renders each MP4 with FFmpeg, updating each reel to "ready" upon finish.
 */
async function runReelGeneration(
  source: string,
  options: GenerateReelsOptions = {}
): Promise<number> {
  const manifest = loadManifest();
  const entry = manifest[source];
  const videoPath = entry?.videoPath ?? path.join(config.uploadDir, source);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`No video file found for "${source}". Reels can only be generated from video uploads.`);
  }

  const safe = safeName(source);
  const outDir = path.join(config.reelsDir, safe);
  fs.mkdirSync(outDir, { recursive: true });

  const durationSec = await probeDurationSec(videoPath);
  const targetDuration = options.targetDurationSec || 45;

  const rawDocs = getDocsBySource(source);

  // Build flat cue array from vector store docs
  const allCues: SubtitleCue[] = rawDocs
    .map((d) => ({
      startSec: typeof d.meta.startSec === 'number' ? d.meta.startSec : NaN,
      endSec: typeof d.meta.endSec === 'number' ? d.meta.endSec : NaN,
      text: d.text.trim(),
    }))
    .filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec) && c.endSec > c.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  // ── STAGE 1: LLM topic boundary detection ──────────────────────────────────
  // For videos shorter than 45s the LLM pass adds no value — use the
  // sentence-boundary fallback directly.
  let sections: SectionWindow[];
  const llmTopics = allCues.length > 0 && (durationSec || 0) >= 45
    ? await llmTopicSegmentation(allCues, durationSec || 60, source)
    : null;

  if (llmTopics && llmTopics.length >= 1) {
    console.log(`[reels] Stage 1: LLM found ${llmTopics.length} topic boundaries for "${source}"`);
    // ── STAGE 2: enforce 30–60s window constraints ──────────────────────────
    const constrained = enforceWindowConstraints(llmTopics, allCues, 30, 60);
    sections = constrained.length > 0 ? constrained : buildEvenSections(durationSec || 60, targetDuration);
    console.log(`[reels] Stage 2: enforced into ${sections.length} 30-60s sections for "${source}"`);
  } else {
    // Fallback: heuristic sentence-boundary segmentation, then run the same
    // Stage 2 constraint enforcement (merge/split) so heuristic output also
    // respects the 30–60s window.
    console.log(`[reels] LLM segmentation unavailable, using heuristic fallback for "${source}"`);
    const heuristic = heuristicSegmentation(rawDocs, targetDuration, 30, 60)
      ?? buildEvenSections(durationSec || 60, targetDuration);
    const heuristicTopics = heuristic.map((s, i) => ({
      title: fallbackTitle(s.text, i),
      startSec: s.start,
      endSec: s.end,
    }));
    const constrained = enforceWindowConstraints(heuristicTopics, allCues, 30, 60);
    sections = constrained.length > 0 ? constrained : heuristic;
    console.log(`[reels] Heuristic: ${sections.length} sections for "${source}"`);
  }

  // Step 1: Prepare all reel metadata & write SRTs immediately
  const reels: ReelInfo[] = [];

  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i];
    const fileBase = `reel_${String(i + 1).padStart(3, '0')}`;
    const srtFileName = `${fileBase}.srt`;
    const srtPath = path.join(outDir, srtFileName);

    // Write SRT caption file immediately
    const cues = sec.cues.length > 0
      ? sec.cues
      : [{ startSec: sec.start, endSec: sec.end, text: sec.text }];

    if (sec.text.trim()) {
      writeSrt(srtPath, cues, sec.start);
    }

    // Title from Stage 1 if available; deterministic fallback otherwise so the
    // manifest can be persisted IMMEDIATELY (hook titles visible in the feed
    // without waiting for the per-section LLM calls).
    const llmTitle = (sec as SectionWindow & { llmTitle?: string }).llmTitle;
    const fallback = fallbackTakeaways(sec.text);

    reels.push({
      id: `${safe}#reel_${String(i + 1).padStart(3, '0')}`,
      source,
      start: sec.start,
      end: sec.end,
      duration: sec.duration,
      startSec: sec.start,
      endSec: sec.end,
      durationSec: sec.duration,
      title: (llmTitle && llmTitle.trim()) || fallbackTitle(sec.text, i),
      video: `/reels/${safe}/${fileBase}.mp4`,
      fileUrl: `/reels/${safe}/${fileBase}.mp4`,
      captions: `/reels/${safe}/${srtFileName}`,
      transcript: sec.text,
      takeaways: fallback,
      summary: fallback[0] || `Key highlights from ${Math.round(sec.duration)}s of the lecture.`,
      status: 'processing',
      cues: sec.cues,
      generatedAt: new Date().toISOString(),
    });
  }

  // Step 2: Persist immediate manifest so the frontend can read all sections right away!
  // Preserve any personalized ("For You") reels created against a previous
  // section set — they carry their own timestamp map.
  const preservedPersonalized = (manifest[source]?.reels ?? []).filter((r) => r.personalized);
  manifest[source] = {
    videoPath,
    durationSec,
    status: 'processing',
    generatedAt: new Date().toISOString(),
    reels: [...preservedPersonalized, ...reels],
  };
  persistManifest(manifest);

  // Step 2b: Enrich takeaways & summary via LLM + RAG, persisting the manifest
  // after every section so the feed fills in progressively (and a crash/restart
  // mid-loop never loses already-generated metadata).
  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i];
    const llmTitle = (sec as SectionWindow & { llmTitle?: string }).llmTitle;
    try {
      const meta = await generateReelMeta(sec.text, source, i, llmTitle);
      reels[i].title = meta.title;
      reels[i].takeaways = meta.takeaways;
      reels[i].summary = meta.summary;
    } catch (err) {
      console.error(`[reels] metadata enrichment failed for clip ${i + 1}:`, (err as Error).message);
    }
    const liveManifest = loadManifest();
    if (liveManifest[source]) {
      // Merge: keep any personalized reels added concurrently, don't clobber them
      const livePreserved = liveManifest[source].reels.filter((r) => r.personalized);
      liveManifest[source].reels = [...livePreserved, ...reels];
      persistManifest(liveManifest);
    }
  }

  // Step 3: Background FFmpeg rendering loop
  (async () => {
    let allSucceeded = true;
    for (let i = 0; i < sections.length; i += 1) {
      const sec = sections[i];
      const reel = reels[i];
      const fileBase = `reel_${String(i + 1).padStart(3, '0')}`;
      const srtFileName = `${fileBase}.srt`;

      console.log(`[reels] rendering clip ${i + 1}/${sections.length} (${sec.duration}s): "${reel.title}"`);
      try {
        await renderReel(videoPath, outDir, fileBase, srtFileName, sec, sec.text.trim().length > 0);
        reel.status = 'ready';
      } catch (err) {
        console.error(`[reels] FFmpeg render failed for clip ${i + 1}:`, (err as Error).message);
        reel.status = 'failed';
        reel.error = (err as Error).message;
        allSucceeded = false;
      }

      // Update live manifest after each clip finishes (merge, don't clobber
      // personalized reels added concurrently)
      const liveManifest = loadManifest();
      if (liveManifest[source]) {
        const livePreserved = liveManifest[source].reels.filter((r) => r.personalized);
        liveManifest[source].reels = [...livePreserved, ...reels];
        persistManifest(liveManifest);
      }
    }

    const finalManifest = loadManifest();
    if (finalManifest[source]) {
      finalManifest[source].status = allSucceeded ? 'completed' : 'ready';
      persistManifest(finalManifest);
    }
    console.log(`[reels] completed all renders for "${source}"`);
  })().catch((err) => {
    console.error(`[reels] background render error for "${source}":`, err.message);
  });

  return reels.length;
}

/**
 * Crash-safe wrapper around the generation pipeline: any unexpected failure
 * is recorded in the manifest (status: "failed") so the frontend always has
 * an up-to-date status to poll — never a stuck "idle" entry.
 */
export async function generateReelsForSource(
  source: string,
  options: GenerateReelsOptions = {}
): Promise<number> {
  try {
    return await runReelGeneration(source, options);
  } catch (err) {
    console.error(`[reels] generation pipeline failed for "${source}":`, (err as Error).message);
    try {
      const manifest = loadManifest();
      if (manifest[source]) {
        manifest[source].status = 'failed';
        manifest[source].error = (err as Error).message;
        persistManifest(manifest);
      }
    } catch { /* best-effort status update */ }
    throw err;
  }
}

export function startReelGeneration(source: string, options: GenerateReelsOptions = {}): boolean {
  // In-flight tracking is process-local (not the persisted manifest status) so
  // a stale "processing" entry from a crashed/restarted server never blocks
  // regeneration.
  if (activeGenerations.has(safeName(source))) return false;
  activeGenerations.add(safeName(source));
  void generateReelsForSource(source, options)
    .catch((err: Error) => {
      console.error(`[reels] generation failed for "${source}":`, err.message);
    })
    .finally(() => {
      activeGenerations.delete(safeName(source));
    });
  return true;
}

/**
 * Returns structured ReelSet matching the user specification.
 */
export function getReels(source?: string): ReelSet[] {
  const manifest = loadManifest();
  const allKeys = [...Object.keys(manifest), ...storeSources(), ...diskVideoSources()];
  const names = new Set<string>();

  if (source) {
    const targetNorm = normalizeFilename(source);
    const found = allKeys.find((k) => normalizeFilename(k) === targetNorm || k === source || safeName(k) === safeName(source));
    names.add(found || source);
  } else {
    for (const k of allKeys) {
      if (!/^\d{13}_[a-f0-9]+(\.|$)/i.test(k)) {
        names.add(k);
      }
    }
  }

  return [...names].sort().map((s) => {
    const norm = normalizeFilename(s);
    const entryKey = Object.keys(manifest).find((k) => normalizeFilename(k) === norm || k === s || safeName(k) === safeName(s));
    const entry = entryKey ? manifest[entryKey] : undefined;
    const videoAvailable = hasVideoFile(s) || (entry ? fs.existsSync(entry.videoPath) : false);

    return {
      source: s,
      status: entry?.status ?? (entry?.reels.length ? 'completed' : 'idle'),
      error: entry?.error,
      videoAvailable,
      durationSec: entry?.durationSec,
      reels: entry?.reels ?? [],
    };
  });

  function storeSources(): string[] {
    try {
      const raw = JSON.parse(fs.readFileSync(config.vectorStorePath, 'utf8')) as Array<{ source: string; meta: { startSec?: unknown } }>;
      const withTime = new Set<string>();
      for (const d of raw) {
        if (typeof d.meta?.startSec === 'number' && !/^\d{13}_[a-f0-9]+(\.|$)/i.test(d.source)) {
          withTime.add(d.source);
        }
      }
      return [...withTime];
    } catch {
      return [];
    }
  }

  function diskVideoSources(): string[] {
    try {
      const files = fs.readdirSync(config.uploadDir);
      return files.filter((f) => {
        if (/^\d{13}_[a-f0-9]+(\.|$)/i.test(f)) return false;
        const ext = path.extname(f).toLowerCase();
        return ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a'].includes(ext);
      });
    } catch {
      return [];
    }
  }
}
