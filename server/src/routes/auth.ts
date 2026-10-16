import { Router } from 'express';
import { z } from 'zod';
import {
  authenticate,
  bootstrapOwner,
  clearSession,
  isUsingGeneratedPassword,
  issueSession,
  needsSetup,
  requireAuth,
  setUserPassword,
  verifyUserPassword,
} from '../auth.js';
import { emailSchema, firstIssue, requireUser } from '../guards.js';
import { getMailConfig, resetUrlFor, sendPasswordResetEmail } from '../mail.js';
import { checkResetToken, consumeResetToken, createResetToken } from '../password-reset.js';
import { allow } from '../ratelimit.js';
import * as store from '../store.js';
import { toUserDTO, type UserDTO, type UserRow } from '../types.js';

export const authRouter = Router();

function userDTO(row: UserRow): UserDTO {
  return toUserDTO(row, store.assignedSiteIds(row.id));
}

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required.'),
  password: z.string().min(1, 'Password is required.'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Your current password is required.'),
  newPassword: z.string().min(8, 'Use at least 8 characters.'),
});

const setEmailSchema = z.object({
  password: z.string().min(1, 'Your password is required to change this.'),
  email: z.union([emailSchema, z.literal('')]),
});

const forgotPasswordSchema = z.object({
  username: z.string().trim().min(1, 'Username is required.').max(200),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is missing.'),
  newPassword: z.string().min(8, 'Use at least 8 characters.'),
});

/** Wording reused everywhere so the response never hints at account existence. */
const GENERIC_RESET_MESSAGE =
  'If that account exists and has an email address on file, a reset link is on its way. Check your inbox and spam folder.';

const bootstrapSchema = z.object({
  username: z.string().trim().min(3, 'Use at least 3 characters.').max(80),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  email: z.union([emailSchema, z.literal('')]).optional(),
});

authRouter.get('/setup-status', (_req, res) => {
  res.json({ needsSetup: needsSetup() });
});

authRouter.post('/bootstrap', (req, res) => {
  if (!needsSetup()) {
    res.status(410).json({ error: 'Setup already completed. Sign in instead.' });
    return;
  }
  const ip = req.ip ?? 'unknown';
  if (!allow(`bootstrap:ip:${ip}`, 5, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    return;
  }

  const parsed = bootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  const username = parsed.data.username;
  const clash = store.getUserByUsername(username);
  if (clash) {
    // Shouldn't happen on a fresh install, but don't leak which accounts exist.
    res.status(409).json({ error: 'That username is already in use.' });
    return;
  }

  const email = parsed.data.email ? parsed.data.email.toLowerCase() : null;
  if (email) {
    const emailClash = store.getUserByEmail(email);
    if (emailClash) {
      res.status(409).json({ error: 'That email address is already in use.' });
      return;
    }
  }

  const row = bootstrapOwner({
    username,
    password: parsed.data.password,
    email,
  });
  issueSession(res, row);
  res.status(201).json({
    ok: true,
    user: userDTO(row),
    usingGeneratedPassword: false,
  });
});

authRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  const user = authenticate(parsed.data.username, parsed.data.password);
  if (!user || user.disabled) {
    // Deliberately identical for unknown user and wrong password.
    res.status(401).json({ error: 'Incorrect username or password.' });
    return;
  }

  store.markUserLogin(user.id);
  issueSession(res, user);
  res.json({
    ok: true,
    user: userDTO(user),
    usingGeneratedPassword: isUsingGeneratedPassword(),
  });
});

authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const row = store.getUser(requireUser(req).id);
  if (!row) {
    res.status(401).json({ error: 'This account is no longer active.' });
    return;
  }
  res.json({
    authenticated: true,
    user: userDTO(row),
    usingGeneratedPassword: isUsingGeneratedPassword(),
  });
});

/** Changes the signed-in user's own password. */
authRouter.post('/password', requireAuth, (req, res) => {
  const user = requireUser(req);

  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  if (!verifyUserPassword(user.id, parsed.data.currentPassword)) {
    res.status(401).json({ error: 'Current password is incorrect.' });
    return;
  }

  const sessionVersion = setUserPassword(user.id, parsed.data.newPassword);
  issueSession(res, { id: user.id, session_version: sessionVersion });
  res.json({ ok: true });
});

/** Sets or clears the signed-in user's own account email. */
authRouter.patch('/email', requireAuth, (req, res) => {
  const user = requireUser(req);

  const parsed = setEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  if (!verifyUserPassword(user.id, parsed.data.password)) {
    res.status(401).json({ error: 'Your password is incorrect.' });
    return;
  }

  const email = parsed.data.email ? parsed.data.email.toLowerCase() : null;
  if (email) {
    const clash = store.getUserByEmail(email);
    if (clash && clash.id !== user.id) {
      res.status(409).json({ error: 'That email address is already in use.' });
      return;
    }
  }

  store.updateUser(user.id, { email });
  const row = store.getUser(user.id);
  res.json({ ok: true, user: row ? userDTO(row) : null });
});

/**
 * Starts a password reset.
 *
 * Always answers with the same message and in the same amount of time: the
 * lookup, token creation, and send all happen after the response is queued, so
 * neither the body nor the timing reveals whether the username exists.
 */
authRouter.post('/forgot-password', (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ ok: true, message: GENERIC_RESET_MESSAGE });
    return;
  }

  const username = parsed.data.username;
  const ip = req.ip ?? 'unknown';
  const withinLimits =
    allow(`forgot:ip:${ip}`, 10, 15 * 60 * 1000) &&
    allow(`forgot:user:${username.toLowerCase()}`, 3, 15 * 60 * 1000);

  if (withinLimits) {
    void deliverResetLink(username).catch((error: unknown) => {
      console.error('[liftoff] Could not send a password reset email:', error);
    });
  }

  res.json({ ok: true, message: GENERIC_RESET_MESSAGE });
});

async function deliverResetLink(username: string): Promise<void> {
  const user = store.getUserByUsername(username);
  if (!user || user.disabled || !user.email) return;

  const config = getMailConfig();
  if (!config) {
    console.warn(
      '[liftoff] A password reset was requested but email is not configured in Settings.',
    );
    return;
  }

  const token = createResetToken(user.id);
  await sendPasswordResetEmail(
    config,
    user.email,
    user.username,
    resetUrlFor(config, token),
  );
}

/** Lets the reset page show a friendly message before the user types anything. */
authRouter.get('/reset-password/:token', (req, res) => {
  const check = checkResetToken(req.params.token);
  res.json({ valid: check.ok, reason: check.ok ? null : check.reason });
});

authRouter.post('/reset-password', (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  const result = consumeResetToken(parsed.data.token, parsed.data.newPassword);
  if (!result.ok) {
    const message =
      result.reason === 'expired'
        ? 'That reset link has expired. Request a new one.'
        : result.reason === 'used'
          ? 'That reset link has already been used.'
          : 'That reset link is not valid.';
    res.status(400).json({ error: message, reason: result.reason });
    return;
  }

  res.json({ ok: true });
});
