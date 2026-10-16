import { createHash, randomBytes } from 'node:crypto';
import { setUserPassword } from './auth.js';
import * as store from './store.js';

const TOKEN_TTL_MS = 60 * 60 * 1000;

/** Only a hash of the token is stored, so a database leak cannot be replayed. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues a fresh token, invalidating any earlier link for the same account. */
export function createResetToken(userId: string): string {
  store.deletePasswordResetsForUser(userId);
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  store.insertPasswordReset({
    token_hash: hashToken(token),
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
    used_at: null,
  });
  return token;
}

export type ResetTokenProblem = 'invalid' | 'expired' | 'used';

export type ResetTokenCheck =
  | { ok: true; userId: string }
  | { ok: false; reason: ResetTokenProblem };

export function checkResetToken(token: string): ResetTokenCheck {
  const row = store.getPasswordReset(hashToken(token));
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (Date.parse(row.expires_at) < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, userId: row.user_id };
}

/**
 * Applies a new password and burns the token. Also bumps the account's session
 * version, so any session an attacker already held stops working.
 */
export function consumeResetToken(
  token: string,
  newPassword: string,
): ResetTokenCheck {
  const check = checkResetToken(token);
  if (!check.ok) return check;

  const tokenHash = hashToken(token);
  store.markPasswordResetUsed(tokenHash);
  setUserPassword(check.userId, newPassword);
  store.deletePasswordResetsForUser(check.userId);
  return { ok: true, userId: check.userId };
}
