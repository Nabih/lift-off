import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (the folder containing package.json + server/ + web/). */
export const REPO_ROOT = path.resolve(here, '..', '..');

/**
 * Where Lift-Off keeps its state. Created on first boot.
 * Layout:
 *   liftoff.db      - sites + deployments
 *   secret.key      - master encryption key (generated if absent)
 *   keys/           - materialised SSH deploy keys + known_hosts
 *   workspaces/     - one git clone per site
 */
export const DATA_DIR = path.resolve(
  process.env.LIFTOFF_DATA_DIR ?? path.join(REPO_ROOT, 'data'),
);
export const KEYS_DIR = path.join(DATA_DIR, 'keys');
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');

/** Built React app, served by Express in production. */
export const WEB_DIST = path.resolve(
  process.env.LIFTOFF_WEB_DIST ?? path.join(REPO_ROOT, 'web', 'dist'),
);

export const PORT = Number(process.env.PORT ?? 4000);
export const IS_PROD = process.env.NODE_ENV === 'production';

/** How many builds run at the same time across all sites. */
export const MAX_CONCURRENT_BUILDS = Math.max(
  1,
  Number(process.env.LIFTOFF_MAX_CONCURRENT_BUILDS ?? 1),
);

export const COOKIE_NAME = 'liftoff_session';
export const SESSION_TTL_DAYS = 30;

/** Hard limits so a runaway build cannot fill the disk. */
export const MAX_LOG_LINES_PER_DEPLOYMENT = 20_000;
export const DEPLOYMENT_HISTORY_PER_SITE = 50;

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, KEYS_DIR, WORKSPACES_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Workspace directory that holds a site's clone. */
export function repoDirFor(siteId: string): string {
  return path.join(WORKSPACES_DIR, siteId, 'repo');
}

/** Path where a site's SSH private key is written before running git. */
export function keyPathFor(siteId: string): string {
  return path.join(KEYS_DIR, siteId);
}

export function knownHostsPath(): string {
  return path.join(KEYS_DIR, 'known_hosts');
}
