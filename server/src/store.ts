import { db } from './db.js';
import { DEPLOYMENT_HISTORY_PER_SITE } from './config.js';
import type { DeploymentRow, LogLine, SiteRow, UserRow } from './types.js';
/* -------------------------------------------------------------------------- */
/* Sites                                                                       */
/* -------------------------------------------------------------------------- */

export function listSites(): SiteRow[] {
  return db
    .prepare('SELECT * FROM sites ORDER BY name COLLATE NOCASE')
    .all() as unknown as SiteRow[];
}

/** Admins see every site; Deployers see only the sites assigned to them. */
export function listSitesForUser(userId: string, isAdmin: boolean): SiteRow[] {
  if (isAdmin) return listSites();
  return db
    .prepare(
      `SELECT s.* FROM sites s
       JOIN user_sites us ON us.site_id = s.id
       WHERE us.user_id = ?
       ORDER BY s.name COLLATE NOCASE`,
    )
    .all(userId) as unknown as SiteRow[];
}

export function getSite(id: string): SiteRow | null {
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  return (row as unknown as SiteRow) ?? null;
}

export function insertSite(site: SiteRow): void {
  db.prepare(
    `INSERT INTO sites (
       id, name, repo_url, branch, auth_type, ssh_private_key, ssh_public_key,
       access_token, install_command, build_command, dist_dir, target_dir,
       deploy_strategy, keep_releases, env_vars, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    site.id,
    site.name,
    site.repo_url,
    site.branch,
    site.auth_type,
    site.ssh_private_key,
    site.ssh_public_key,
    site.access_token,
    site.install_command,
    site.build_command,
    site.dist_dir,
    site.target_dir,
    site.deploy_strategy,
    site.keep_releases,
    site.env_vars,
    site.enabled,
    site.created_at,
    site.updated_at,
  );
}

/** Column names are supplied by our own code, never by request payloads. */
export function updateSite(id: string, patch: Record<string, unknown>): void {
  const columns = Object.keys(patch);
  if (columns.length === 0) return;
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  db.prepare(`UPDATE sites SET ${assignments}, updated_at = ? WHERE id = ?`).run(
    ...columns.map((column) => patch[column] as never),
    new Date().toISOString(),
    id,
  );
}

export function deleteSite(id: string): void {
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
}

/* -------------------------------------------------------------------------- */
/* Deployments                                                                 */
/* -------------------------------------------------------------------------- */

export function getDeployment(id: string): DeploymentRow | null {
  const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(id);
  return (row as unknown as DeploymentRow) ?? null;
}

export function listDeployments(options: {
  siteId?: string;
  limit?: number;
}): DeploymentRow[] {
  const limit = options.limit ?? 50;
  if (options.siteId) {
    return db
      .prepare(
        'SELECT * FROM deployments WHERE site_id = ? ORDER BY queued_at DESC LIMIT ?',
      )
      .all(options.siteId, limit) as unknown as DeploymentRow[];
  }
  return db
    .prepare('SELECT * FROM deployments ORDER BY queued_at DESC LIMIT ?')
    .all(limit) as unknown as DeploymentRow[];
}

export function listDeploymentsWithSiteName(options: {
  siteId?: string;
  limit?: number;
  /** When set, only deployments for these sites are returned. */
  restrictSiteIds?: string[];
}): Array<DeploymentRow & { site_name: string; site_repo_url: string | null }> {
  const limit = options.limit ?? 50;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.siteId) {
    conditions.push('d.site_id = ?');
    params.push(options.siteId);
  }

  if (options.restrictSiteIds) {
    if (options.restrictSiteIds.length === 0) return [];
    const placeholders = options.restrictSiteIds.map(() => '?').join(',');
    conditions.push(`d.site_id IN (${placeholders})`);
    params.push(...options.restrictSiteIds);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT d.*, s.name AS site_name, s.repo_url AS site_repo_url FROM deployments d
       LEFT JOIN sites s ON s.id = d.site_id
       ${where}
       ORDER BY d.queued_at DESC LIMIT ?`,
    )
    .all(...params, limit) as unknown as Array<DeploymentRow & { site_name: string; site_repo_url: string | null }>;
}

export function insertDeployment(row: DeploymentRow): void {
  db.prepare(
    `INSERT INTO deployments (
       id, site_id, kind, status, branch, commit_sha, commit_message, redeploy,
       triggered_by, error, queued_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.site_id,
    row.kind,
    row.status,
    row.branch,
    row.commit_sha,
    row.commit_message,
    row.redeploy,
    row.triggered_by,
    row.error,
    row.queued_at,
    row.started_at,
    row.finished_at,
  );
}

export function updateDeployment(id: string, patch: Record<string, unknown>): void {
  const columns = Object.keys(patch);
  if (columns.length === 0) return;
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  db.prepare(`UPDATE deployments SET ${assignments} WHERE id = ?`).run(
    ...columns.map((column) => patch[column] as never),
    id,
  );
}

export function getDeploymentLogs(
  deploymentId: string,
  afterSeq = 0,
  limit = 5_000,
): Array<LogLine & { seq: number }> {
  const rows = db
    .prepare(
      `SELECT seq, ts, stream, line FROM deployment_logs
       WHERE deployment_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(deploymentId, afterSeq, limit) as unknown as Array<LogLine & { seq: number }>;
  return rows;
}

/** Keeps only the most recent N deployments per site. Logs cascade-delete. */
export function pruneDeployments(siteId: string): void {
  const stale = db
    .prepare(
      `SELECT id FROM deployments WHERE site_id = ?
       ORDER BY queued_at DESC LIMIT -1 OFFSET ?`,
    )
    .all(siteId, DEPLOYMENT_HISTORY_PER_SITE) as unknown as Array<{ id: string }>;
  const remove = db.prepare('DELETE FROM deployments WHERE id = ?');
  for (const row of stale) remove.run(row.id);
}

/**
 * Any deployment left mid-flight by a restart can never finish, so mark it
 * failed on boot instead of leaving it "running" forever.
 */
export function failStuckDeployments(): number {
  const result = db
    .prepare(
      `UPDATE deployments
       SET status = 'failed',
           error = COALESCE(error, 'Interrupted by a server restart.'),
           finished_at = ?
       WHERE status IN ('queued', 'running')`,
    )
    .run(new Date().toISOString());
  return Number(result.changes ?? 0);
}

/**
 * What is currently serving for a site: the newest successful deployment that
 * recorded a commit. A rollback records the commit it rolled back to, so this
 * stays accurate after a rollback rather than pointing at the release that was
 * superseded.
 */
export function getLiveDeployment(siteId: string): DeploymentRow | null {
  const row = db
    .prepare(
      `SELECT * FROM deployments
       WHERE site_id = ? AND status = 'success' AND commit_sha IS NOT NULL
       ORDER BY COALESCE(finished_at, queued_at) DESC LIMIT 1`,
    )
    .get(siteId) as unknown as DeploymentRow | undefined;
  return row ?? null;
}

/**
 * Finds the deployment that produced a commit, given a short sha. Release
 * directory names only carry a 7-character sha, so a rollback uses this to
 * recover the full commit and branch it reverted to.
 */
export function findDeploymentByShaPrefix(
  siteId: string,
  prefix: string,
): DeploymentRow | null {
  const row = db
    .prepare(
      `SELECT * FROM deployments
       WHERE site_id = ? AND commit_sha LIKE ? AND status = 'success'
       ORDER BY COALESCE(finished_at, queued_at) DESC LIMIT 1`,
    )
    .get(siteId, `${prefix}%`) as unknown as DeploymentRow | undefined;
  return row ?? null;
}

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

export function countUsers(): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  return Number(row?.count ?? 0);
}

export function listUsers(): UserRow[] {
  return db
    .prepare('SELECT * FROM users ORDER BY is_owner DESC, username COLLATE NOCASE')
    .all() as unknown as UserRow[];
}

export function getUser(id: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return (row as unknown as UserRow) ?? null;
}

export function getUserByUsername(username: string): UserRow | null {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username);
  return (row as unknown as UserRow) ?? null;
}

export function insertUser(user: UserRow): void {
  db.prepare(
    `INSERT INTO users (
       id, username, password_hash, email, role, is_owner, disabled,
       session_version, created_at, created_by, last_login_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.username,
    user.password_hash,
    user.email,
    user.role,
    user.is_owner,
    user.disabled,
    user.session_version,
    user.created_at,
    user.created_by,
    user.last_login_at,
  );
}

export function updateUser(id: string, patch: Record<string, unknown>): void {
  const columns = Object.keys(patch);
  if (columns.length === 0) return;
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${assignments} WHERE id = ?`).run(
    ...columns.map((column) => patch[column] as never),
    id,
  );
}

export function deleteUser(id: string): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function markUserLogin(id: string): void {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id,
  );
}

export function assignedSiteIds(userId: string): string[] {
  const rows = db
    .prepare('SELECT site_id FROM user_sites WHERE user_id = ?')
    .all(userId) as unknown as Array<{ site_id: string }>;
  return rows.map((row) => row.site_id);
}

export function isSiteAssigned(userId: string, siteId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM user_sites WHERE user_id = ? AND site_id = ?')
    .get(userId, siteId);
  return Boolean(row);
}

/** Replaces a user's site assignments in one transaction. */
export function setUserSites(userId: string, siteIds: string[]): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM user_sites WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO user_sites (user_id, site_id) VALUES (?, ?)',
    );
    for (const siteId of siteIds) {
      if (getSite(siteId)) insert.run(userId, siteId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** All (user, site) assignment pairs, so the users list needs one query. */
export function allUserSitePairs(): Array<{ user_id: string; site_id: string }> {
  return db
    .prepare('SELECT user_id, site_id FROM user_sites')
    .all() as unknown as Array<{ user_id: string; site_id: string }>;
}

/** Users assigned to a site. */
export function assignedUserIds(siteId: string): string[] {
  const rows = db
    .prepare('SELECT user_id FROM user_sites WHERE site_id = ?')
    .all(siteId) as unknown as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}

/**
 * Replaces the set of users assigned to a site, in one transaction. Only
 * Deployers are ever stored: Admins reach every site regardless, so assigning
 * one would be meaningless.
 */
export function setSiteUsers(siteId: string, userIds: string[]): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM user_sites WHERE site_id = ?').run(siteId);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO user_sites (user_id, site_id) VALUES (?, ?)',
    );
    for (const userId of userIds) {
      const user = getUser(userId);
      if (user && user.role === 'deployer') insert.run(userId, siteId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getUserByEmail(email: string): UserRow | null {
  const row = db
    .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(email);
  return (row as unknown as UserRow) ?? null;
}

/** Invalidate every existing session for a user (used after a password change). */
export function bumpSessionVersion(id: string): number {
  db.prepare(
    'UPDATE users SET session_version = session_version + 1 WHERE id = ?',
  ).run(id);
  return getUser(id)?.session_version ?? 1;
}

/* -------------------------------------------------------------------------- */
/* Password resets                                                             */
/* -------------------------------------------------------------------------- */

export interface PasswordResetRow {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export function insertPasswordReset(row: PasswordResetRow): void {
  db.prepare(
    `INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.token_hash, row.user_id, row.created_at, row.expires_at, row.used_at);
}

export function getPasswordReset(tokenHash: string): PasswordResetRow | null {
  const row = db
    .prepare('SELECT * FROM password_resets WHERE token_hash = ?')
    .get(tokenHash);
  return (row as unknown as PasswordResetRow) ?? null;
}

export function markPasswordResetUsed(tokenHash: string): void {
  db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(
    new Date().toISOString(),
    tokenHash,
  );
}

/** Called when a new token is issued, so only the newest link works. */
export function deletePasswordResetsForUser(userId: string): void {
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
}

/** Housekeeping so the table cannot grow without bound. */
export function prunePasswordResets(): void {
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(
    new Date().toISOString(),
  );
}
