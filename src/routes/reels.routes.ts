/**
 * GET  /api/reels            — all generated reel sets and statuses
 * GET  /api/reels?source=... — reels for one specific uploaded video
 * POST /api/reels/generate   — trigger reel generation (30–60s clips):
 *                              { "source": "lecture.mp4", "targetDurationSec"?: 30 | 45 | 60 }
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getReels, startReelGeneration, generateReelsForSource } from '../services/reel.service.js';
import { HttpError } from '../middleware/validate.middleware.js';
import type { ReelsResponse } from '../types/ingest.js';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
  const sources = getReels(source || undefined);

  if (source) {
    const set = sources.find((s) => s.source === source) || {
      source,
      status: 'idle' as const,
      videoAvailable: false,
      reels: [],
    };
    res.json({
      ok: true,
      source,
      status: set.status,
      videoAvailable: set.videoAvailable,
      durationSec: set.durationSec,
      reels: set.reels,
    });
    return;
  }

  res.json({ ok: true, sources });
});

router.post(
  '/generate',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
      if (!source) throw new HttpError(400, 'Body must be JSON like { "source": "video.mp4" }');

      const targetDurationSec = typeof req.body?.targetDurationSec === 'number'
        ? Math.min(60, Math.max(20, req.body.targetDurationSec))
        : 45;

      const reelCount = typeof req.body?.reelCount === 'number'
        ? Math.min(20, Math.max(1, req.body.reelCount))
        : undefined;

      const sync = req.body?.sync === true;

      if (sync) {
        const count = await generateReelsForSource(source, { targetDurationSec, reelCount });
        const set = getReels(source)[0];
        res.json({ ok: true, source, count, reels: set?.reels ?? [], status: 'ready' });
      } else {
        const started = startReelGeneration(source, { targetDurationSec, reelCount });
        res.json({
          ok: true,
          source,
          started,
          message: started
            ? `30–60s reel generation started for "${source}"`
            : `Generation is already in progress for "${source}"`,
          status: 'generating',
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

export default router;
