/**
 * Authentication & authorization middleware.
 *
 *  - requireAuth  : verifies the bearer token, attaches req.user
 *  - requireRole  : restricts a route to one or more roles
 *
 * Usage:
 *   router.get('/me', requireAuth, handler);
 *   router.post('/content', requireAuth, requireRole('admin', 'trainer'), handler);
 */
import type { Request, Response, NextFunction } from 'express';
import { verifyToken, isAuthEnabled } from '../services/auth.service.js';
import type { UserRole } from '../types/auth.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: UserRole;
      };
    }
  }
}

/**
 * Verify the bearer token and populate req.user.
 * Responds 401 when the token is missing/invalid.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isAuthEnabled()) {
    res.status(503).json({ error: 'Auth is not configured on this server.' });
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  const user = await verifyToken(token);

  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }

  req.user = user;
  next();
}

/**
 * Restrict the route to the given roles. Must run after requireAuth.
 * Usage: requireRole('admin') or requireRole('admin', 'trainer')
 */
export function requireRole(...allowed: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({
        error: `Forbidden — requires one of: ${allowed.join(', ')}`,
      });
      return;
    }
    next();
  };
}
