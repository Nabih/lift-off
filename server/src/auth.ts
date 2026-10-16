import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { COOKIE_NAME, SESSION_TTL_DAYS } from './config.js';
import { hashPassword, randomId, randomToken, verifyPassword } from './crypto.js';
import { getSetting, setSetting } from './db.js';
import * as store from './store.js';
import type { Role, UserRow } from './types.js';

const SECRET_KEY = 'jwt_secret';
const GENERATED_FLAG = 'admin_password_generated';
/** Pre-users-table password location, kept only for one-time migration. */
const LEGACY_HASH_KEY = 'admin_password_hash';

/** The authenticated identity attached to each request. */
export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  isOwner: boolean;
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    isOwner: Boolean(row.is_owner),
  };
}

function printGeneratedPassword(password: string): void {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  Lift-Off generated an owner password (change it soon):    │');
  console.log(`  │      ${password.padEnd(52)}│`);
  console.log('  └──────────────────────────────────────────────────────────┘');
  console.log('');
}

/**
 * Prepares auth state on boot:
 *  - a JWT signing secret (random, persisted)
 *  - the owner account, created once from (in order) a pre-existing password
 *    hash, LIFTOFF_ADMIN_PASSWORD, or a newly generated password.
 *
 * Upgrades from the single-password version keep working: the old hash is
 * moved onto the owner account, so nobody is locked out.
 */

export function needsSetup(): boolean {
  return store.countUsers() === 0;
}

export function bootstrapOwner(input: {
  username: string;
  password: string;
  email: string | null;
}): UserRow {
  const row: UserRow = {
    id: randomId('user'),
    username: input.username,
    password_hash: hashPassword(input.password),
    email: input.email,
    role: 'admin',
    is_owner: 1,
    disabled: 0,
    session_version: 1,
    created_at: new Date().toISOString(),
    created_by: null,
    last_login_at: null,
  };
  store.insertUser(row);
  return row;
}

export function initAuth(): void {
  if (!getSetting(SECRET_KEY)) {
    setSetting(SECRET_KEY, randomToken(32));
  }

  if (store.countUsers() > 0) return;

  const legacyHash = getSetting(LEGACY_HASH_KEY);
  const environmentPassword = process.env.LIFTOFF_ADMIN_PASSWORD;

  // Bootstrap non-interactively only when explicitly asked to: a legacy hash
  // (from the pre-users version) or an explicit LIFTOFF_ADMIN_PASSWORD. This
  // keeps a plaintext password out of the default setup flow — fresh installs
  // are provisioned through the first-run wizard in the UI (or `npm run
  // seed:admin`), so nothing secret has to live in .env or the README.
  if (legacyHash || environmentPassword) {
    let passwordHash: string;
    let generated = false;

    if (legacyHash) {
      passwordHash = legacyHash;
      generated = getSetting(GENERATED_FLAG) === '1';
    } else {
      passwordHash = hashPassword(environmentPassword as string);
    }

    const username =
      (process.env.LIFTOFF_ADMIN_USERNAME ?? 'admin').trim() || 'admin';

    store.insertUser({
      id: randomId('user'),
      username,
      password_hash: passwordHash,
      email: null,
      role: 'admin',
      is_owner: 1,
      disabled: 0,
      session_version: 1,
      created_at: new Date().toISOString(),
      created_by: null,
      last_login_at: null,
    });
    setSetting(GENERATED_FLAG, generated ? '1' : '0');

    console.log(
      `[liftoff] Owner account "${username}" created${
        legacyHash ? ' (migrated existing admin password)' : ''
      }.`,
    );
    return;
  }

  console.log('[liftoff] No owner account exists yet.');
  console.log('[liftoff] Open the UI to complete first-run setup, or set LIFTOFF_ADMIN_PASSWORD to bootstrap non-interactively.');
  console.log('[liftoff] (CLI: `npm run seed:admin`.)');
}

function jwtSecret(): string {
  const secret = getSetting(SECRET_KEY);
  if (!secret) throw new Error('Auth is not initialised.');
  return secret;
}

/**
 * scrypt hash of a throwaway value. Verifying against it when the username is
 * unknown keeps the response time similar to a real (wrong-password) attempt,
 * so usernames cannot be enumerated by timing.
 */
let decoyHash: string | null = null;

/** Verifies credentials. Returns the user row, or null. */
export function authenticate(username: string, password: string): UserRow | null {
  const user = store.getUserByUsername(username);
  if (!user) {
    decoyHash ??= hashPassword(randomToken(16));
    verifyPassword(password, decoyHash);
    return null;
  }
  return verifyPassword(password, user.password_hash) ? user : null;
}

export function verifyUserPassword(userId: string, password: string): boolean {
  const user = store.getUser(userId);
  if (!user) return false;
  return verifyPassword(password, user.password_hash);
}

export function setUserPassword(userId: string, password: string): number {
  store.updateUser(userId, { password_hash: hashPassword(password) });
  const user = store.getUser(userId);
  if (user?.is_owner) setSetting(GENERATED_FLAG, '0');
  // Invalidate existing sessions for this account; the caller re-issues one.
  return store.bumpSessionVersion(userId);
}

export function isUsingGeneratedPassword(): boolean {
  return getSetting(GENERATED_FLAG) === '1';
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  // Enable when the UI is served over HTTPS (directly or via a proxy).
  secure: process.env.LIFTOFF_COOKIE_SECURE === 'true',
  maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
};

export function issueSession(
  res: Response,
  user: { id: string; session_version: number },
): void {
  const token = jwt.sign(
    { sub: user.id, sv: user.session_version },
    jwtSecret(),
    { expiresIn: SESSION_TTL_DAYS * 24 * 60 * 60 },
  );
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
}

function tokenFromRequest(req: Request): string | null {
  const fromCookie = (req as Request & { cookies?: Record<string, string> })
    .cookies?.[COOKIE_NAME];
  if (fromCookie) return fromCookie;

  const header = req.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

/**
 * Resolves the session to a live user record on every request, so role changes,
 * disabling, or deletion take effect immediately rather than at token expiry.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = tokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  let userId: string | null = null;
  let tokenVersion = 1;
  try {
    const payload = jwt.verify(token, jwtSecret());
    if (payload && typeof payload === 'object' && typeof payload.sub === 'string') {
      userId = payload.sub;
      // Tokens issued before session versioning default to 1, matching accounts
      // that have never had a password change, so nobody is logged out by the
      // upgrade itself.
      tokenVersion = typeof payload.sv === 'number' ? payload.sv : 1;
    }
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return;
  }

  if (!userId) {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return;
  }

  const row = store.getUser(userId);
  if (!row || row.disabled) {
    clearSession(res);
    res.status(401).json({ error: 'This account is no longer active.' });
    return;
  }

  if (tokenVersion !== row.session_version) {
    // The password was changed (or reset) after this session was issued.
    clearSession(res);
    res.status(401).json({ error: 'Your password changed. Please sign in again.' });
    return;
  }

  req.user = toAuthUser(row);
  next();
}
