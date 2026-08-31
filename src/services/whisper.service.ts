/**
 * Whisper service — local speech-to-text via whisper.cpp (nodejs-whisper).
 *
 *   audio (16 kHz mono WAV)
 *           ↓
 *      whisper.cpp  (Metal GPU-accelerated on Apple Silicon)
 *           ↓
 *      Transcript + timestamps
 *
 * No API key, no cloud — everything runs locally.
 */
import fs from 'node:fs';
import { nodewhisper } from 'nodejs-whisper';
import { config } from '../config/index.js';
import type { TranscriptSegment } from '../types/ingest.js';

/** "00:01:23,450" | "00:01:23.450" → seconds (float) */
export function timestampToSeconds(ts: string): number {
  const clean = ts.replace(',', '.');
  const parts = clean.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/** Parse whisper-cli stdout lines: "[00:00:00.000 --> 00:00:03.840]  text" */
export function parseTimestampedLines(stdout: string): TranscriptSegment[] {
  const re =
    /\[(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.+)/g;
  const segments: TranscriptSegment[] = [];
  for (const match of stdout.matchAll(re)) {
    segments.push({
      startSec: timestampToSeconds(match[1]),
      endSec: timestampToSeconds(match[2]),
      text: match[3].trim(),
    });
  }
  return segments;
}

/** Parse SRT blocks: "1\n00:00:00,000 --> 00:00:03,840\ntext" */
export function parseSrt(srt: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const block of srt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const tsIndex = lines.findIndex((l) => l.includes('-->'));
    if (tsIndex === -1) continue;
    const [start, end] = lines[tsIndex].split('-->').map((s) => s.trim());
    const text = lines.slice(tsIndex + 1).join(' ');
    segments.push({
      startSec: timestampToSeconds(start),
      endSec: timestampToSeconds(end),
      text,
    });
  }
  return segments;
}

export interface TranscribeOptions {
  onProgress?: (info: Record<string, unknown>) => void;
}

/**
 * Transcribe a 16 kHz mono WAV file with whisper.cpp.
 * @returns ordered transcript segments with timestamps in seconds
 */
export async function transcribeAudio(
  wavPath: string,
  { onProgress }: TranscribeOptions = {}
): Promise<TranscriptSegment[]> {
  if (!fs.existsSync(wavPath)) {
    throw new Error(`Audio file not found: ${wavPath}`);
  }

  onProgress?.({ stage: 'transcription-started', model: config.whisperModel });

  const output = await nodewhisper(wavPath, {
    modelName: config.whisperModel,
    autoDownloadModelName: config.whisperModel,
    modelRootPath: config.whisperModelRoot,
    removeWavFileAfterTranscription: false,
    whisperOptions: {
      outputInSrt: true, // also writes a .srt next to the wav as a backup
      translateToEnglish: false,
      wordTimestamps: false,
    },
  });

  // nodewhisper resolves with whisper-cli's raw stdout
  let segments = parseTimestampedLines(output ?? '');

  // Fallback: parse the generated .srt file if stdout parsing came up empty
  if (segments.length === 0) {
    const srtPath = `${wavPath}.srt`;
    if (fs.existsSync(srtPath)) {
      segments = parseSrt(fs.readFileSync(srtPath, 'utf8'));
    }
  }

  return segments.filter((seg) => seg.text);
}
