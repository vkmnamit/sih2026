/**
 * Video service — the video ingestion pipeline orchestrator.
 *
 *   Teacher uploads video
 *           ↓
 *      Extract audio   (ffmpeg → 16 kHz mono WAV, what whisper.cpp wants)
 *           ↓
 *      Speech-to-text  (whisper.service — whisper.cpp)
 *           ↓
 *      Transcript + timestamps  → segments ready for chunking
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config/index.js';
import type { Segment } from '../types/ingest.js';
import { transcribeAudio, type TranscribeOptions } from './whisper.service.js';

/** Run ffmpeg, rejecting with its captured stderr on failure. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Extract mono 16 kHz PCM audio from any video/audio file.
 * @returns path to the extracted WAV
 */
export async function extractAudio(mediaPath: string, outDir: string): Promise<string> {
  const wavPath = path.join(
    outDir,
    `${path.basename(mediaPath, path.extname(mediaPath))}_16k.wav`
  );
  await runFfmpeg([
    '-i', mediaPath,
    '-vn',                                  // drop video stream
    '-acodec', 'pcm_s16le',                 // 16-bit PCM
    '-ar', String(config.audioSampleRate),  // whisper expects 16 kHz
    '-ac', '1',                             // mono
    wavPath,
  ]);
  return wavPath;
}

export interface VideoIngestResult {
  segments: Segment[];
  durationSec: number;
}

/**
 * Full video pipeline: extract audio → transcribe → segments ready for chunking.
 * @param mediaPath uploaded video/audio file
 * @param outDir    where the intermediate WAV is staged
 */
export async function extractVideoSegments(
  mediaPath: string,
  outDir: string,
  opts: TranscribeOptions = {}
): Promise<VideoIngestResult> {
  const wavPath = await extractAudio(mediaPath, outDir);
  try {
    const rawSegments = await transcribeAudio(wavPath, opts);
    const segments: Segment[] = rawSegments.map((seg) => ({
      text: seg.text,
      meta: { startSec: seg.startSec, endSec: seg.endSec },
    }));
    const durationSec = rawSegments.length
      ? rawSegments[rawSegments.length - 1].endSec
      : 0;
    return { segments, durationSec };
  } finally {
    // clean up intermediate audio + any sidecar files whisper wrote
    for (const suffix of ['', '.srt', '.vtt', '.txt', '.json']) {
      fs.rmSync(`${wavPath}${suffix}`, { force: true });
    }
  }
}
