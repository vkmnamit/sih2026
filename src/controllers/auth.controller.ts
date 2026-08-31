/**
 * Auth HTTP handlers — thin wrappers around auth.service.
 */
import type { Request, Response, NextFunction } from 'express';
import { signup, login, getProfile, isAuthEnabled } from '../services/auth.service.js';
import { USER_ROLES } from '../types/auth.js';
import type { UserRole } from '../types/auth.js';

function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** POST /api/auth/signup */
export async function signupHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!isAuthEnabled()) {
      res.status(503).json({ error: 'Auth is not configured on this server.' });
      return;
    }

    const { email, password, role, name } = req.body ?? {};

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'email is required.' });
      return;
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      res.status(400).json({ error: 'password must be at least 6 characters.' });
      return;
    }
    if (!isUserRole(role)) {
      res.status(400).json({ error: `role must be one of: ${USER_ROLES.join(', ')}` });
      return;
    }

    const result = await signup({ email, password, role, name });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

/** POST /api/auth/login */
export async function loginHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!isAuthEnabled()) {
      res.status(503).json({ error: 'Auth is not configured on this server.' });
      return;
    }

    const { email, password } = req.body ?? {};

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'email is required.' });
      return;
    }
    if (!password || typeof password !== 'string') {
      res.status(400).json({ error: 'password is required.' });
      return;
    }

    const result = await login({ email, password });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/auth/me — returns the current user's profile. */
export async function meHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated.' });
      return;
    }
    const profile = await getProfile(req.user.id);
    res.status(200).json({
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      name: profile?.name ?? null,
    });
  } catch (err) {
    next(err);
  }
}
