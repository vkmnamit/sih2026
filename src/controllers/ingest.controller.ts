/**
 * Ingest controller — the layer that talks HTTP.
 *
 *   POST /api/ingest/pdf    → pdf.service   → chunking.service
 *   POST /api/ingest/video  → video.service → chunking.service → reel.service (30-60s reels)
 *   POST /api/ingest        → auto-detect by extension, then delegate
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { extractPdfSegments } from '../services/pdf.service.js';
import { extractVideoSegments } from '../services/video.service.js';
import { chunkSegments } from '../services/chunking.service.js';
import { indexChunks } from '../services/rag.service.js';
import { generateCardsForSource } from '../services/content-cards.service.js';
import { registerVideoFile, startReelGeneration } from '../services/reel.service.js';
import { normalizeFilename } from '../middleware/upload.middleware.js';
import type { MediaIngestResponse, PdfIngestResponse } from '../types/ingest.js';

export function ingestPdf(req: Request, res: Response<PdfIngestResponse>, next: NextFunction): void {
  handlePdf(req, res, next);
}

export function ingestVideo(req: Request, res: Response<MediaIngestResponse>, next: NextFunction): void {
  handleVideo(req, res, next);
}

// ---------------------------------------------------------------- internals

function handlePdf(req: Request, res: Response<PdfIngestResponse>, next: NextFunction): void {
  const staged = req.file!.path;
  const fileName = normalizeFilename(req.file!.originalname);
  runPipeline(
    async () => {
      const segments = await extractPdfSegments(staged, {
        onProgress: (info) =>
          console.log(`[pdf] page ${info.page}/${info.totalPages} (${info.method})`),
      });
      const chunks = chunkSegments(segments, {
        maxChars: config.chunkMaxChars,
        overlapChars: config.chunkOverlapChars,
      });
      const indexed = await safeRagIndex(fileName, chunks);
      if (indexed > 0) startCardGeneration(fileName);
      return {
        ok: true as const,
        type: 'pdf' as const,
        fileName,
        stats: {
          pages: segments.length,
          ocrUsed: segments.some((s) => s.meta.extraction === 'ocr'),
          chunks: chunks.length,
        },
        chunks,
        indexed,
      };
    },
    staged,
    res,
    next
  );
}

function handleVideo(req: Request, res: Response<MediaIngestResponse>, next: NextFunction): void {
  const staged = req.file!.path;
  const fileName = normalizeFilename(req.file!.originalname);
  const preservedPath = path.join(config.uploadDir, fileName);

  // Preserve the video file in uploads/<originalname> so reel rendering has access to it
  try {
    if (staged !== preservedPath) {
      fs.copyFileSync(staged, preservedPath);
    }
    registerVideoFile(fileName, preservedPath);
  } catch (err) {
    console.warn('[video] could not preserve video file for reels:', (err as Error).message);
  }

  runPipeline(
    async () => {
      const { segments, durationSec } = await extractVideoSegments(staged, config.uploadDir, {
        onProgress: (info) => console.log('[video]', info),
      });
      const chunks = chunkSegments(segments, {
        maxChars: config.chunkMaxChars,
        overlapChars: config.chunkOverlapChars,
      });
      const indexed = await safeRagIndex(fileName, chunks);

      // Auto-trigger AI Content Cards & 30–60s Reels in the background
      if (indexed > 0) {
        startCardGeneration(fileName);
      }
      startReelGeneration(fileName, { targetDurationSec: 45 });

      return {
        ok: true as const,
        type: 'video' as const,
        fileName,
        stats: {
          segments: segments.length,
          durationSec,
          chunks: chunks.length,
        },
        chunks,
        indexed,
      };
    },
    staged,
    res,
    next,
    staged === preservedPath // don't delete if it was uploaded straight to target
  );
}

/**
 * Shared wrapper: run a pipeline, always clean up the staged upload, forward errors.
 * Indexing is done separately (safeRagIndex) so an embedding failure never
 * fails the ingest itself.
 */
async function safeRagIndex(source: string, chunks: { text: string; meta: unknown }[]): Promise<number> {
  try {
    return await indexChunks(source, chunks as never);
  } catch (err) {
    console.error('[rag] indexing failed (ingest still succeeds):', (err as Error).message);
    return 0;
  }
}

/**
 * Fire-and-forget AI Content Engine run after a successful ingest. Runs in
 * the background (LLM calls for every topic can take a while) — cards appear
 * via GET /api/cards when ready. Never fails the ingest.
 */
function startCardGeneration(source: string): void {
  void generateCardsForSource(source)
    .then((n) => console.log(`[cards] ${n} cards ready for "${source}"`))
    .catch((err: Error) => console.error(`[cards] generation failed for "${source}":`, err.message));
}

/** Shared wrapper: run a pipeline, clean up staged upload (unless preserved), forward errors */
async function runPipeline<T>(
  pipeline: () => Promise<T>,
  stagedPath: string,
  res: Response<T>,
  next: NextFunction,
  skipCleanup = false
): Promise<void> {
  try {
    const result = await pipeline();
    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    if (!skipCleanup) {
      fs.rmSync(stagedPath, { force: true });
    }
  }
}
