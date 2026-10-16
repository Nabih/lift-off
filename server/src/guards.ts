import type { NextFunction, Request, Response } from 'express';
import { z, type ZodError } from 'zod';
import type { AuthUser } from './auth.js';
import * as store from './store.js';

/** An error carrying an intended HTTP status. */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Assumes requireAuth has already run. Throws if it has not. */
export function requireUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return req.user;
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (req.user.role !== 'admin') {
    res
      .status(403)
      .json({ error: 'Administrator access is required for this action.' });
    return;
  }
  next();
}

export function isAdmin(user: AuthUser): boolean {
  return user.role === 'admin';
}

/** Admins reach every site; Deployers only the sites assigned to them. */
export function canAccessSite(user: AuthUser, siteId: string): boolean {
  return isAdmin(user) || store.isSiteAssigned(user.id, siteId);
}

export function firstIssue(error: ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request.';
}

/**
 * Email addresses are only used as a password-reset channel, so they are
 * normalised to lower case before storage to match the case-insensitive index.
 */
export const emailSchema = z
  .string()
  .trim()
  .max(254, 'That email address is too long.')
  .email('Enter a valid email address.');
