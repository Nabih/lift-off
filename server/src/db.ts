import { createRequire } from 'node:module';
import path from 'node:path';
import { DATA_DIR, ensureDirs } from './config.js';

// node:sqlite ships with Node >= 22.5 and needs no native compilation. The
// typings only exist in newer @types/node releases, so we load it through
// createRequire and describe the small surface we use.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDb;
};

interface SqliteStatement {
  run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

ensureDirs();

export const db: SqliteDb = new DatabaseSync(path.join(DATA_DIR, 'liftoff.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    repo_url          TEXT NOT NULL,
    branch            TEXT NOT NULL DEFAULT 'master',
    auth_type         TEXT NOT NULL DEFAULT 'ssh',
    ssh_private_key   TEXT,
    ssh_public_key    TEXT,
    access_token      TEXT,
    install_command   TEXT NOT NULL DEFAULT 'npm ci',
    build_command     TEXT NOT NULL DEFAULT 'npm run build',
    dist_dir          TEXT NOT NULL DEFAULT 'dist',
    target_dir        TEXT NOT NULL,
    deploy_strategy   TEXT NOT NULL DEFAULT 'releases',
    keep_releases     INTEGER NOT NULL DEFAULT 5,
    env_vars          TEXT NOT NULL DEFAULT '{}',
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id               TEXT PRIMARY KEY,
    site_id          TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL DEFAULT 'deploy',
    status           TEXT NOT NULL,
    commit_sha       TEXT,
    commit_message   TEXT,
    triggered_by     TEXT,
    error            TEXT,
    queued_at        TEXT NOT NULL,
    started_at       TEXT,
    finished_at      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_deployments_site
    ON deployments(site_id, queued_at DESC);

  CREATE TABLE IF NOT EXISTS deployment_logs (
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    ts            TEXT NOT NULL,
    stream        TEXT NOT NULL,
    line          TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_logs_deployment
    ON deployment_logs(deployment_id, seq);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    email           TEXT,
    role            TEXT NOT NULL DEFAULT 'deployer',
    is_owner        INTEGER NOT NULL DEFAULT 0,
    disabled        INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    created_by      TEXT,
    last_login_at   TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
    ON users(username COLLATE NOCASE);

  -- Which sites a Deployer may act on. Admins ignore this table entirely.
  CREATE TABLE IF NOT EXISTS user_sites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, site_id)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_password_resets_user
    ON password_resets(user_id);
`);

/**
 * Adds a column to an existing table when it is missing. `CREATE TABLE IF NOT
 * EXISTS` does not evolve a table, so databases created by earlier versions need
 * this to pick up new columns.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('sites', 'access_token', 'TEXT');
ensureColumn('users', 'email', 'TEXT');
ensureColumn('users', 'session_version', 'INTEGER NOT NULL DEFAULT 1');

// Created after the migration above, since it references users(email).
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
    ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
`);

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? String(row.value) : null;
}

export function setSetting(key: string, value: string): void {
  db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}
