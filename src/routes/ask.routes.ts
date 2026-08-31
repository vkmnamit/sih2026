/**
 * POST /api/ask — RAG question answering.
 * Body: { "question": "Explain binary search" }
 * GET  /api/ask/_stats — vector store statistics for the test frontend.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ask } from '../services/rag.service.js';
import { stats } from '../services/vector-store.service.js';
import { HttpError } from '../middleware/validate.middleware.js';
import type { AskResponse } from '../types/ingest.js';

const router = Router();

router.get('/_stats', (_req, res) => {
  res.json({ ok: true, ...stats() });
});

router.post(
  '/',
  async (req: Request, res: Response<AskResponse>, next: NextFunction): Promise<void> => {
    try {
      const question = typeof req.body?.question === 'string' ? req.body.question : '';
      if (!question.trim()) {
        throw new HttpError(400, 'Body must be JSON like { "question": "..." }');
      }
      // Optional scoping: only search chunks from one uploaded file
      const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
      res.json(await ask(question, source ? { source } : {}));
    } catch (err) {
      next(err);
    }
  }
);

export default router;

