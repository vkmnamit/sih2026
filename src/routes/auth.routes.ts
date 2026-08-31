/**
 * Authentication routes.
 *
 *   POST /api/auth/signup — create an account (admin, trainer, or trainee)
 *   POST /api/auth/login  — log in, receive a JWT
 *   GET  /api/auth/me     — current user's profile (requires auth)
 */
import { Router } from 'express';
import { signupHandler, loginHandler, meHandler } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/signup', signupHandler);
router.post('/login', loginHandler);
router.get('/me', requireAuth, meHandler);

export default router;
