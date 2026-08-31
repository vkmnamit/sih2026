/**
 * Reel service — turns an uploaded video into vertical (9:16) reels (30–60s clips)
 * with burned-in captions, AI hook titles, topic summaries, and rich subtitle cues.
 *
 *   uploaded video (preserved in uploads/<source>)
 *        ↓
 *   transcript windows  (30–60s segments with startSec/endSec; falls
 *                        back to evenly-spaced windows when no transcript)
 *        ↓
 *   LLM hook title & summary (viral/educational social hooks + takeaways)
 *        ↓
 *   ffmpeg render       (blurred-background 9:16 canvas + styled SRT captions)
 *        ↓
 *   data/reels/<safeSource>/reel_N.mp4  + manifest.json
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { getDocsBySource } from './vector-store.service.js';
import { chatComplete } from './llm.service.js';
import type { ReelInfo, ReelSet } from '../types/ingest.js';

const MANIFEST_PATH = path.join(config.reelsDir, 'manifest.json');

interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

interface WindowSpec {
  startSec: number;
  endSec: number;
  text: string;
  cues: SubtitleCue[];
}

interface ManifestEntry {
  videoPath: string;
  durationSec?: number;
  generatedAt: string;
  reels: ReelInfo[];
}

type Manifest = Record<string, ManifestEntry>;

interface Job {
  status: 'generating' | 'ready' | 'failed';
  error?: string;
  progress?: string;
}

/** In-memory generation job state (per source). */
const jobs = new Map<string, Job>();

// ------------------------------------------------------------------ helpers

/** Filesystem-safe version of a source name (used for reel directories). */
export function safeName(source: string): string {
  return source.replace(/[^a-zA-Z0-9._-]+/g, '_');
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

/** True when the original video for a source survived ingest (uploads/). */
export function hasVideoFile(source: string): boolean {
  return fs.existsSync(path.join(config.uploadDir, source));
}

/** Get source video path if available */
export function getVideoPath(source: string): string | null {
  const manifest = loadManifest();
  const entry = manifest[source];
  if (entry && fs.existsSync(entry.videoPath)) return entry.videoPath;
  const p = path.join(config.uploadDir, source);
  if (fs.existsSync(p)) return p;
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

/**
 * Split transcript docs into 30–60s consecutive windows snapped to speech segments.
 * Returns null when the transcript has no usable timestamps.
 */
function buildTranscriptWindows(
  docs: { text: string; meta: Record<string, unknown> }[],
  targetDurationSec = 45,
  maxClipSec = 60,
  minClipSec = 20
): WindowSpec[] | null {
  const segs: SubtitleCue[] = docs
    .map((d) => ({
      startSec: typeof d.meta.startSec === 'number' ? d.meta.startSec : NaN,
      endSec: typeof d.meta.endSec === 'number' ? d.meta.endSec : NaN,
      text: d.text.trim(),
    }))
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  if (segs.length === 0) return null;

  const windows: WindowSpec[] = [];
  let curCues: SubtitleCue[] = [];
  let winStart = segs[0].startSec;

  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    curCues.push(seg);
    const curLen = seg.endSec - winStart;

    // Check if we reached target window duration (e.g. 30s–60s) or reached the end
    const isLast = i === segs.length - 1;
    const shouldClose = curLen >= targetDurationSec || curLen >= maxClipSec || (isLast && curLen >= minClipSec);

    if (shouldClose) {
      const fullText = curCues.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
      windows.push({
        startSec: winStart,
        endSec: seg.endSec,
        text: fullText,
        cues: [...curCues],
      });
      curCues = [];
      if (i + 1 < segs.length) {
        winStart = segs[i + 1].startSec;
      }
    }
  }

  // If there are leftover cues that didn't form a window, merge them into the last window or make one
  if (curCues.length > 0) {
    const lastSeg = curCues[curCues.length - 1];
    const fullText = curCues.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
    if (windows.length > 0 && lastSeg.endSec - windows[windows.length - 1].startSec <= maxClipSec + 15) {
      const last = windows[windows.length - 1];
      last.endSec = lastSeg.endSec;
      last.text += ` ${fullText}`;
      last.cues.push(...curCues);
    } else {
      windows.push({
        startSec: winStart,
        endSec: lastSeg.endSec,
        text: fullText,
        cues: curCues,
      });
    }
  }

  // Sample or cap if there are too many windows
  const maxAllowed = Math.max(config.reelCount, 8);
  if (windows.length <= maxAllowed) return windows;

  const step = windows.length / maxAllowed;
  const picked: WindowSpec[] = [];
  for (let i = 0; i < maxAllowed; i += 1) {
    picked.push(windows[Math.floor(i * step)]);
  }
  return picked;
}

/** Evenly spaced fallback windows (30-60s) when no usable transcript exists. */
function buildEvenWindows(durationSec: number, clipDurationSec = 45): WindowSpec[] {
  const count = Math.max(1, Math.min(config.reelCount, Math.ceil(durationSec / clipDurationSec)));
  const clipLen = Math.min(clipDurationSec, Math.max(20, durationSec / count));
  const step = count > 1 ? (durationSec - clipLen) / (count - 1) : 0;
  const windows: WindowSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.min(Math.max(0, i * step), Math.max(0, durationSec - 2));
    const end = Math.min(durationSec, start + clipLen);
    windows.push({
      startSec: Math.round(start * 10) / 10,
      endSec: Math.round(end * 10) / 10,
      text: '',
      cues: [],
    });
  }
  return windows;
}

/** Write a formatted .srt subtitle file with clean timestamps (times shifted by offsetSec). */
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

/** First-sentence fallback title from the window transcript. */
function fallbackTitle(text: string, index = 0): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return `Key Highlight #${index + 1}`;
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] || clean;
  return firstSentence.length > 60 ? `${firstSentence.slice(0, 57)}…` : firstSentence;
}

/** LLM hook title and key takeaway summary for a 30-60s reel window. */
async function generateReelMeta(windowText: string, source: string, index: number): Promise<{ title: string; summary: string }> {
  const fbTitle = fallbackTitle(windowText, index);
  const cleanText = windowText.replace(/\s+/g, ' ').trim();
  const fbSummary = cleanText.length > 140 ? `${cleanText.slice(0, 137)}…` : cleanText;

  if (!cleanText) {
    return { title: fbTitle, summary: 'Key video segment highlight.' };
  }

  try {
    const raw = await chatComplete(
      [
        {
          role: 'system',
          content:
            'You are an AI video editor creating short 30-60s vertical educational reels. ' +
            'Write a punchy hook title (max 7 words, captivating) and a 1-sentence key takeaway summary. ' +
            'Respond with ONLY JSON format: {"title": "...", "summary": "..."}',
        },
        {
          role: 'user',
          content: `Source: ${source}\n\nTranscript excerpt (30-60s clip):\n${cleanText.slice(0, 1000)}\n\nGenerate hook title and 1-sentence takeaway summary.`,
        },
      ],
      { temperature: 0.5, maxTokens: 150 }
    );

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { title?: string; summary?: string };
      const title = (parsed.title || '').replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 75);
      const summary = (parsed.summary || '').replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 200);
      return {
        title: title || fbTitle,
        summary: summary || fbSummary,
      };
    }
    return { title: fbTitle, summary: fbSummary };
  } catch {
    return { title: fbTitle, summary: fbSummary };
  }
}

/**
 * Render ONE vertical reel (9:16) with blurred background canvas, centered video,
 * and high-contrast burned-in SRT captions.
 */
async function renderReel(
  videoPath: string,
  outDir: string,
  fileBase: string,
  win: WindowSpec,
  hasCaptions: boolean
): Promise<void> {
  const { reelWidth: W, reelHeight: H } = config;
  const srtName = `${fileBase}.srt`;

  const cuesToWrite = win.cues.length > 0
    ? win.cues
    : [{ startSec: win.startSec, endSec: win.endSec, text: win.text }];

  if (hasCaptions && win.text.trim()) {
    writeSrt(path.join(outDir, srtName), cuesToWrite, win.startSec);
  }

  const withCaptions = hasCaptions && win.text.trim();
  const clipDuration = Math.max(1, win.endSec - win.startSec);

  const filters = [
    '[0:v]split=2[bg][fg]',
    `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:5[bgb]`,
    `[fg]scale=${W}:-2[fgs]`,
    '[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v0]',
    withCaptions
      ? `[v0]subtitles=${srtName}:force_style='FontName=Arial,Fontsize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=60'[vout]`
      : '[v0]null[vout]',
  ];

  await runFfmpeg(
    [
      '-ss', String(win.startSec),
      '-t', String(clipDuration),
      '-i', videoPath,
      '-filter_complex', filters.join(';'),
      '-map', '[vout]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      `${fileBase}.mp4`,
    ],
    outDir
  );
}

// ------------------------------------------------------------------ public API

/** Register the kept video for a source (called by the ingest controller). */
export function registerVideoFile(source: string, videoPath: string): void {
  const manifest = loadManifest();
  const entry = manifest[source];
  if (!entry) {
    manifest[source] = { videoPath, generatedAt: '', reels: [] };
  } else {
    entry.videoPath = videoPath;
  }
  persistManifest(manifest);
}

export interface GenerateReelsOptions {
  targetDurationSec?: number; // 30, 45, 60s
  reelCount?: number;
}

/**
 * Render all 30–60s reels for one source.
 * Idempotent — re-running replaces the previous reel set.
 */
export async function generateReelsForSource(
  source: string,
  options: GenerateReelsOptions = {}
): Promise<number> {
  const manifest = loadManifest();
  const entry = manifest[source];
  const videoPath = entry?.videoPath ?? path.join(config.uploadDir, source);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`No video file found for "${source}". Reels can only be generated from video uploads.`);
  }

  const targetDuration = options.targetDurationSec || 45;
  jobs.set(source, { status: 'generating', progress: 'Initializing reel generation...' });
  const outDir = path.join(config.reelsDir, safeName(source));
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const durationSec = await probeDurationSec(videoPath);
    if (durationSec <= 1) throw new Error(`Could not read video duration (is ${videoPath} a valid video file?)`);

    const rawDocs = getDocsBySource(source);
    const windows = buildTranscriptWindows(rawDocs, targetDuration, 60, 20) ?? buildEvenWindows(durationSec, targetDuration);
    const reels: ReelInfo[] = [];

    console.log(`[reels] starting generation for ${source} (${windows.length} clips, ~${targetDuration}s each)...`);

    for (let i = 0; i < windows.length; i += 1) {
      const win = windows[i];
      const fileBase = `reel_${String(i).padStart(2, '0')}`;
      jobs.set(source, {
        status: 'generating',
        progress: `Rendering clip ${i + 1} of ${windows.length} (${Math.round(win.endSec - win.startSec)}s)...`,
      });

      const { title, summary } = await generateReelMeta(win.text, source, i);
      console.log(`[reels] rendering ${fileBase} (${win.startSec.toFixed(1)}s–${win.endSec.toFixed(1)}s) "${title}"`);

      try {
        await renderReel(videoPath, outDir, fileBase, win, win.text.trim().length > 0);
        reels.push({
          id: `${source}#reel_${i}`,
          source,
          startSec: win.startSec,
          endSec: win.endSec,
          durationSec: Math.round((win.endSec - win.startSec) * 10) / 10,
          title,
          summary,
          transcript: win.text,
          cues: win.cues,
          fileUrl: `/reels/${safeName(source)}/${fileBase}.mp4`,
          sourceVideoUrl: `/uploads/${encodeURIComponent(source)}`,
          generatedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[reels] ${fileBase} ffmpeg render failed:`, (err as Error).message);
        // Fallback reel entry for web player
        reels.push({
          id: `${source}#reel_${i}`,
          source,
          startSec: win.startSec,
          endSec: win.endSec,
          durationSec: Math.round((win.endSec - win.startSec) * 10) / 10,
          title,
          summary,
          transcript: win.text,
          cues: win.cues,
          fileUrl: `/uploads/${encodeURIComponent(source)}#t=${win.startSec},${win.endSec}`,
          sourceVideoUrl: `/uploads/${encodeURIComponent(source)}`,
          generatedAt: new Date().toISOString(),
        });
      }
    }

    if (reels.length === 0) throw new Error('Every reel render failed — check the server logs.');

    manifest[source] = {
      videoPath,
      durationSec,
      generatedAt: new Date().toISOString(),
      reels,
    };
    persistManifest(manifest);
    jobs.set(source, { status: 'ready', progress: `Done — ${reels.length} reels ready!` });
    console.log(`[reels] done — ${reels.length} reels ready for ${source}`);
    return reels.length;
  } catch (err) {
    jobs.set(source, { status: 'failed', error: (err as Error).message });
    throw err;
  }
}

/** Fire-and-forget background render. */
export function startReelGeneration(source: string, options: GenerateReelsOptions = {}): boolean {
  if (jobs.get(source)?.status === 'generating') return false;
  jobs.set(source, { status: 'generating', progress: 'Starting reel generation...' });
  void generateReelsForSource(source, options)
    .then((n) => console.log(`[reels] ${n} reels ready for "${source}"`))
    .catch((err: Error) => console.error(`[reels] generation failed for "${source}":`, err.message));
  return true;
}

/**
 * Reel sets for the UI: every source that has either rendered reels or a
 * preserved video file. Includes live job status and progress.
 */
export function getReels(source?: string): ReelSet[] {
  const manifest = loadManifest();
  const names = new Set<string>(source
    ? [source]
    : [...Object.keys(manifest), ...storeSources(), ...diskVideoSources()]);

  return [...names].sort().map((s) => {
    const job = jobs.get(s);
    const entry = manifest[s];
    const videoAvailable = hasVideoFile(s) || (entry ? fs.existsSync(entry.videoPath) : false);

    return {
      source: s,
      status: job?.status ?? (entry?.reels.length ? 'ready' : 'idle'),
      error: job?.error,
      videoAvailable,
      durationSec: entry?.durationSec,
      reels: entry?.reels ?? [],
    };
  });

  /** Sources in the vector store that carry video timestamps. */
  function storeSources(): string[] {
    try {
      const raw = JSON.parse(fs.readFileSync(config.vectorStorePath, 'utf8')) as Array<{ source: string; meta: { startSec?: unknown } }>;
      const withTime = new Set<string>();
      for (const d of raw) {
        if (typeof d.meta?.startSec === 'number') withTime.add(d.source);
      }
      return [...withTime];
    } catch {
      return [];
    }
  }

  /** Files in uploads directory with media extensions */
  function diskVideoSources(): string[] {
    try {
      const files = fs.readdirSync(config.uploadDir);
      return files.filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a'].includes(ext);
      });
    } catch {
      return [];
    }
  }
}
