import type { AuthUser } from './auth.js';

/**
 * Adds `req.user` to Express's Request type. Populated by requireAuth and read
 * by the permission helpers in guards.ts.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
