/**
 * Route registry — mounts every feature router under /api.
 */
import { Router } from 'express';
import authRoutes from './auth.routes.js';
import ingestRoutes from './ingest.routes.js';
import askRoutes from './ask.routes.js';
import cardsRoutes from './cards.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/ingest', ingestRoutes);
router.use('/ask', askRoutes);
router.use('/cards', cardsRoutes);

export default router;
