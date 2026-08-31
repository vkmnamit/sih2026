/**
 * GET  /api/cards            — all generated cards
 * GET  /api/cards?source=... — cards for one uploaded file
 * POST /api/cards/generate   — (re)generate cards for one source:
 *                              { "source": "file.pdf", "depth"?: 1 | 2 }
 *                              depth 1 = one card per topic/subtopic,
 *                              depth 2 = whole-chapter (multiple cards per big section)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { generateCardsForSource, getCards } from '../services/content-cards.service.js';
import { HttpError } from '../middleware/validate.middleware.js';
import type { CardsResponse } from '../types/ingest.js';

const router = Router();

router.get('/', (req: Request, res: Response<CardsResponse>) => {
  const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
  const format = typeof req.query.format === 'string' ? req.query.format.trim() : '';
  let cards = getCards(source || undefined);
  if (format === 'post' || format === 'carousel') {
    cards = cards.filter((c) => (c.format ?? 'post') === format);
  }
  res.json({ ok: true, source: source || null, cards });
});

router.post(
  '/generate',
  async (req: Request, res: Response<CardsResponse>, next: NextFunction): Promise<void> => {
    try {
      const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
      if (!source) throw new HttpError(400, 'Body must be JSON like { "source": "file.pdf" }');
      const depth = typeof req.body?.depth === 'number' ? req.body.depth : undefined;
      if (depth !== undefined && depth !== 1 && depth !== 2) {
        throw new HttpError(400, 'depth must be 1 (basic) or 2 (whole-chapter)');
      }
      const format = typeof req.body?.format === 'string' && req.body.format === 'carousel' ? 'carousel' : 'post';
      const count = await generateCardsForSource(source, depth, format);
      res.json({ ok: true, source, cards: getCards(source) });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
