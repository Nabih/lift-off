import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, REPO_ROOT } from './config.js';
import type { BuildLogger } from './log.js';
import type { DeployStrategy, SiteRow } from './types.js';

/**
 * Refuses obviously destructive targets before we delete anything. Deployments
 * can wipe a directory (direct strategy), so this is deliberately strict.
 */
export function validateTargetDir(targetDir: string): string {
  const raw = (targetDir ?? '').trim();
  if (!raw) throw new Error('Target directory is required.');
  if (!path.isAbsolute(raw)) {
    throw new Error('Target directory must be an absolute path (e.g. /var/www/my-site).');
  }
  const resolved = path.resolve(raw);
  if (resolved === '/') {
    throw new Error('Target directory cannot be the filesystem root.');
  }
  if (resolved === DATA_DIR || resolved.startsWith(DATA_DIR + path.sep)) {
    throw new Error("Target directory cannot be inside Lift-Off's data directory.");
  }
  if (resolved === REPO_ROOT) {
    throw new Error('Target directory cannot be the Lift-Off project directory.');
  }
  return resolved;
}

/** Resolves the build output folder and keeps it inside the repo. */
export function resolveDistDir(repoDir: string, distDir: string): string {
  const cleaned = (distDir || 'dist').trim();
  if (path.isAbsolute(cleaned)) {
    throw new Error('Output directory must be relative to the repository (e.g. "dist").');
  }
  const resolved = path.resolve(repoDir, cleaned);
  const rel = path.relative(repoDir, resolved);
  if (rel === '') {
    throw new Error('Output directory cannot be the repository root.');
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Output directory must be inside the repository.');
  }
  return resolved;
}

async function copyDirContents(source: string, destination: string): Promise<void> {
  await fsp.mkdir(destination, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirContents(from, to);
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(from);
      await fsp.rm(to, { recursive: true, force: true });
      await fsp.symlink(linkTarget, to);
    } else {
      await fsp.copyFile(from, to);
    }
  }
}

/**
 * Release directory prefix. Recency is inferred by sorting release names, so
 * this must be strictly increasing to millisecond precision: two deploys inside
 * the same second would otherwise be ordered by their commit SHA, which would
 * make rollback and pruning pick the wrong release.
 */
function timestamp(date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fsp.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Suffixes the name if a release with the same timestamp and commit already exists. */
async function uniqueReleaseName(releasesDir: string, base: string): Promise<string> {
  if (!(await pathExists(path.join(releasesDir, base)))) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(await pathExists(path.join(releasesDir, candidate)))) return candidate;
  }
  throw new Error(`Could not find a free release directory name for ${base}.`);
}

async function readSymlinkTarget(linkPath: string): Promise<string | null> {
  try {
    const target = await fsp.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

async function sortedReleases(releasesDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(releasesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function swapCurrentSymlink(targetDir: string, releaseName: string): Promise<void> {
  const currentLink = path.join(targetDir, 'current');
  const tempLink = path.join(targetDir, `.current-${process.pid}-${Date.now()}`);
  await fsp.symlink(path.join('releases', releaseName), tempLink);
  // rename(2) over an existing symlink is atomic on POSIX, so a web server
  // reading targetDir/current never sees a missing link.
  await fsp.rename(tempLink, currentLink);
}

async function pruneReleases(
  releasesDir: string,
  keep: number,
  currentTarget: string | null,
  log: BuildLogger,
): Promise<void> {
  const releases = await sortedReleases(releasesDir);
  const surplus = releases.slice(0, Math.max(0, releases.length - keep));
  for (const name of surplus) {
    const full = path.join(releasesDir, name);
    if (currentTarget && path.resolve(full) === path.resolve(currentTarget)) continue;
    await fsp.rm(full, { recursive: true, force: true });
    log.info(`Pruned old release ${name}`);
  }
}

export interface DeployResult {
  strategy: DeployStrategy;
  targetDir: string;
  releaseDir?: string;
  /** Name of the release folder this deploy created (releases strategy only). */
  releaseName?: string;
  previousReleaseDir?: string | null;
}

async function deployDirect(
  targetDir: string,
  sourceDir: string,
  log: BuildLogger,
): Promise<DeployResult> {
  await fsp.mkdir(targetDir, { recursive: true });
  log.info(`Clearing ${targetDir} …`);
  const existing = await fsp.readdir(targetDir);
  for (const name of existing) {
    await fsp.rm(path.join(targetDir, name), { recursive: true, force: true });
  }
  log.info(`Copying build output into ${targetDir} …`);
  await copyDirContents(sourceDir, targetDir);
  return { strategy: 'direct', targetDir };
}

async function deployReleases(
  site: SiteRow,
  targetDir: string,
  sourceDir: string,
  sha: string,
  log: BuildLogger,
): Promise<DeployResult> {
  const releasesDir = path.join(targetDir, 'releases');
  await fsp.mkdir(releasesDir, { recursive: true });

  const releaseName = await uniqueReleaseName(
    releasesDir,
    `${timestamp()}-${sha.slice(0, 7)}`,
  );
  const releaseDir = path.join(releasesDir, releaseName);
  const currentLink = path.join(targetDir, 'current');
  const previousReleaseDir = await readSymlinkTarget(currentLink);

  await fsp.mkdir(releaseDir, { recursive: true });
  log.info(`Creating release ${releaseName} …`);
  await copyDirContents(sourceDir, releaseDir);

  log.info(`Switching ${currentLink} -> releases/${releaseName}`);
  await swapCurrentSymlink(targetDir, releaseName);

  await pruneReleases(releasesDir, site.keep_releases, releaseDir, log);

  return {
    strategy: 'releases',
    targetDir,
    releaseDir,
    releaseName,
    previousReleaseDir,
  };
}

/** Ships the built output to its destination using the site's strategy. */
export async function deployArtifact(
  site: SiteRow,
  sourceDir: string,
  sha: string,
  log: BuildLogger,
): Promise<DeployResult> {
  const targetDir = validateTargetDir(site.target_dir);

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(sourceDir);
  } catch {
    throw new Error(
      `Build output "${site.dist_dir}" was not produced by the build command.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Build output "${site.dist_dir}" is not a directory.`);
  }

  if (site.deploy_strategy === 'direct') {
    return deployDirect(targetDir, sourceDir, log);
  }
  return deployReleases(site, targetDir, sourceDir, sha, log);
}

export interface ReleaseInfo {
  name: string;
  path: string;
  isCurrent: boolean;
}

export async function listReleases(targetDir: string): Promise<ReleaseInfo[]> {
  const resolved = validateTargetDir(targetDir);
  const releasesDir = path.join(resolved, 'releases');
  const releases = await sortedReleases(releasesDir);
  const current = await readSymlinkTarget(path.join(resolved, 'current'));
  return releases.reverse().map((name) => ({
    name,
    path: path.join(releasesDir, name),
    isCurrent: current === path.join(releasesDir, name),
  }));
}

/**
 * The short commit sha encoded in a release directory name. Names are
 * `<YYYYMMDD>-<HHmmss>-<mmm>-<sha7>`, optionally suffixed with `-N` when two
 * deploys share a millisecond, so the sha is always the fourth dash-segment.
 */
export function releaseNameSha(releaseName: string): string | null {
  const sha = releaseName.split('-')[3] ?? '';
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

export async function switchRelease(
  targetDir: string,
  releaseName: string,
  log: BuildLogger,
): Promise<{ releaseName: string }> {
  const resolved = validateTargetDir(targetDir);
  const releasesDir = path.join(resolved, 'releases');
  const releases = await sortedReleases(releasesDir);
  if (!releases.includes(releaseName)) {
    throw new Error(`Release "${releaseName}" was not found on this site.`);
  }
  log.info(`Switching current -> releases/${releaseName}`);
  await swapCurrentSymlink(resolved, releaseName);
  return { releaseName };
}

export interface RollbackResult {
  releaseDir: string;
  releaseName: string;
}

/** Points `current` at the release immediately before the active one. */
export async function rollbackRelease(
  targetDir: string,
  log: BuildLogger,
): Promise<RollbackResult> {
  const resolved = validateTargetDir(targetDir);
  const releasesDir = path.join(resolved, 'releases');
  const releases = await sortedReleases(releasesDir);
  const current = await readSymlinkTarget(path.join(resolved, 'current'));
  const currentName = current ? path.basename(current) : null;
  const position = currentName ? releases.indexOf(currentName) : releases.length;
  const previous = releases[position - 1];

  if (!previous) {
    throw new Error('No previous release is available to roll back to.');
  }

  log.info(`Rolling back ${path.join(resolved, 'current')} -> releases/${previous}`);
  await swapCurrentSymlink(resolved, previous);
  return { releaseDir: path.join(releasesDir, previous), releaseName: previous };
}
