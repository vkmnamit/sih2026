/**
 * GET  /api/reels            — all generated reel sets and statuses
 * GET  /api/reels?source=... — reels manifest for one specific uploaded video
 * POST /api/reels/generate   — trigger reel generation (30–60s clips):
 *                              { "source": "lecture.mp4", "targetDurationSec"?: 30 | 45 | 60 }
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getReels, startReelGeneration, generateReelsForSource, generatePersonalizedReel } from '../services/reel.service.js';
import { HttpError } from '../middleware/validate.middleware.js';

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
        ? Math.min(60, Math.max(25, req.body.targetDurationSec))
        : 45;

      const sync = req.body?.sync === true;

      if (sync) {
        const count = await generateReelsForSource(source, { targetDurationSec });
        const set = getReels(source)[0];
        res.json({
          ok: true,
          source,
          count,
          status: set?.status ?? 'completed',
          durationSec: set?.durationSec,
          reels: set?.reels ?? [],
        });
      } else {
        const started = startReelGeneration(source, { targetDurationSec });
        res.json({
          ok: true,
          source,
          started,
          message: started
            ? `30–60s reel generation started for "${source}"`
            : `Generation is already in progress for "${source}"`,
          status: 'processing',
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/personalize',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
      const interests = Array.isArray(req.body?.interests)
        ? req.body.interests
            .filter((x: unknown) => typeof x === 'string' && x.trim().length > 0)
            .map((x: string) => x.trim())
            .slice(0, 8)
        : [];

      if (!source) {
        throw new HttpError(400, 'Body must include { "source": "video.mp4", "interests": ["binary search", ...] }');
      }
      if (interests.length === 0) {
        throw new HttpError(400, 'Provide at least one interest, e.g. { "interests": ["time complexity"] }');
      }

      const result = await generatePersonalizedReel(source, interests);
      if (!result) {
        throw new HttpError(404, `No indexed sections found for "${source}". Generate reels first (POST /api/reels/generate).`);
      }

      res.json({ ok: true, source, interests, ...result });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
