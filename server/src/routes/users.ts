import { Router } from 'express';
import { z } from 'zod';
import { setUserPassword } from '../auth.js';
import { hashPassword, randomId } from '../crypto.js';
import { emailSchema, firstIssue, requireUser } from '../guards.js';
import * as store from '../store.js';
import { toUserDTO, type UserDTO, type UserRow } from '../types.js';

export const usersRouter = Router();

const usernameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z0-9._-]{3,32}$/,
    'Username must be 3–32 characters using letters, numbers, dot, dash, or underscore.',
  );

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters.');

const roleSchema = z.enum(['admin', 'deployer']);

/** Blank string clears the address; omitted leaves it untouched on update. */
const optionalEmail = z.union([emailSchema, z.literal('')]);

const createSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: optionalEmail.optional(),
  role: roleSchema.default('deployer'),
  siteIds: z.array(z.string()).default([]),
});

const updateSchema = z.object({
  username: usernameSchema.optional(),
  password: passwordSchema.optional(),
  email: optionalEmail.optional(),
  role: roleSchema.optional(),
  disabled: z.boolean().optional(),
  siteIds: z.array(z.string()).optional(),
});

function normalizeEmail(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

/** Returns an error message when the address is taken by someone else. */
function emailConflict(email: string | null, exceptUserId: string): string | null {
  if (!email) return null;
  const existing = store.getUserByEmail(email);
  if (existing && existing.id !== exceptUserId) {
    return 'That email address is already in use.';
  }
  return null;
}

function userDTO(row: UserRow): UserDTO {
  return toUserDTO(row, store.assignedSiteIds(row.id));
}

usersRouter.get('/', (_req, res) => {
  const pairs = store.allUserSitePairs();
  const byUser = new Map<string, string[]>();
  for (const pair of pairs) {
    const list = byUser.get(pair.user_id) ?? [];
    list.push(pair.site_id);
    byUser.set(pair.user_id, list);
  }
  res.json({
    users: store
      .listUsers()
      .map((row) => toUserDTO(row, byUser.get(row.id) ?? [])),
  });
});

usersRouter.post('/', (req, res) => {
  const actor = requireUser(req);

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { username, password, email: rawEmail, role, siteIds } = parsed.data;

  if (store.getUserByUsername(username)) {
    res.status(409).json({ error: 'That username is already taken.' });
    return;
  }

  const email = normalizeEmail(rawEmail);
  const conflict = emailConflict(email, '');
  if (conflict) {
    res.status(409).json({ error: conflict });
    return;
  }

  const row: UserRow = {
    id: randomId('user'),
    username,
    password_hash: hashPassword(password),
    email,
    role,
    is_owner: 0,
    disabled: 0,
    session_version: 1,
    created_at: new Date().toISOString(),
    created_by: actor.id,
    last_login_at: null,
  };
  store.insertUser(row);
  if (role === 'deployer') store.setUserSites(row.id, siteIds);

  res.status(201).json(userDTO(store.getUser(row.id)!));
});

usersRouter.patch('/:id', (req, res) => {
  const actor = requireUser(req);
  const target = store.getUser(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const data = parsed.data;

  // The owner account is protected: only the owner may touch it, and it must
  // stay an enabled admin so the system can never be locked out.
  if (target.is_owner && !actor.isOwner) {
    res
      .status(403)
      .json({ error: 'The owner account can only be modified by the owner.' });
    return;
  }
  if (target.is_owner) {
    if (data.role && data.role !== 'admin') {
      res.status(409).json({ error: 'The owner account must remain an admin.' });
      return;
    }
    if (data.disabled) {
      res.status(409).json({ error: 'The owner account cannot be disabled.' });
      return;
    }
  }

  if (data.username && data.username.toLowerCase() !== target.username.toLowerCase()) {
    const clash = store.getUserByUsername(data.username);
    if (clash && clash.id !== target.id) {
      res.status(409).json({ error: 'That username is already taken.' });
      return;
    }
  }

  if (data.email !== undefined) {
    const conflict = emailConflict(normalizeEmail(data.email), target.id);
    if (conflict) {
      res.status(409).json({ error: conflict });
      return;
    }
  }

  if (target.id === actor.id) {
    if (data.role && data.role !== 'admin') {
      res.status(409).json({ error: 'You cannot remove your own admin role.' });
      return;
    }
    if (data.disabled) {
      res.status(409).json({ error: 'You cannot disable your own account.' });
      return;
    }
  }

  const patch: Record<string, unknown> = {};
  if (data.username !== undefined) patch.username = data.username;
  if (data.role !== undefined) patch.role = data.role;
  if (data.disabled !== undefined) patch.disabled = data.disabled ? 1 : 0;
  if (data.email !== undefined) patch.email = normalizeEmail(data.email);
  if (Object.keys(patch).length > 0) store.updateUser(target.id, patch);

  // Resetting someone's password ends their sessions too.
  if (data.password !== undefined) {
    setUserPassword(target.id, data.password);
  }

  if (data.role === 'admin') {
    // Admins reach every site, so assignments are meaningless for them.
    store.setUserSites(target.id, []);
  } else if (data.siteIds !== undefined) {
    store.setUserSites(target.id, data.siteIds);
  }

  res.json(userDTO(store.getUser(target.id)!));
});

usersRouter.delete('/:id', (req, res) => {
  const actor = requireUser(req);
  const target = store.getUser(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  if (target.is_owner) {
    res.status(409).json({ error: 'The owner account cannot be deleted.' });
    return;
  }
  if (target.id === actor.id) {
    res.status(409).json({ error: 'You cannot delete your own account.' });
    return;
  }

  store.deleteUser(target.id);
  res.json({ ok: true });
});
