import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACES_DIR, keyPathFor, knownHostsPath, repoDirFor } from './config.js';
import { decrypt } from './crypto.js';
import type { BuildLogger } from './log.js';
import { capture, runStreaming } from './process.js';
import type { AuthType, SiteRow } from './types.js';

/**
 * The subset of a site that decides how git authenticates. Keeping this narrow
 * lets callers validate repository settings that have not been saved yet, by
 * passing the form's values plus any stored secret.
 */
export interface GitAuth {
  id: string;
  auth_type: AuthType;
  ssh_private_key: string | null;
  access_token: string | null;
}

export interface RepoSyncResult {
  sha: string;
  subject: string;
  cloned: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ensureTrailingNewline(key: string): string {
  return key.endsWith('\n') ? key : `${key}\n`;
}

/**
 * Builds the environment git runs with.
 *
 * SSH sites: the encrypted private key is decrypted and materialised at 0600,
 * then referenced via GIT_SSH_COMMAND so we never touch the caller's ~/.ssh
 * config. StrictHostKeyChecking=accept-new trusts a host on first contact (TOFU)
 * and pins it in our own known_hosts from then on.
 *
 * Token sites: the token is injected as an HTTP Authorization header through
 * git's GIT_CONFIG_* environment variables. That keeps it out of argv (visible in
 * `ps`) and out of .git/config (persisted on disk in the workspace).
 */
export function buildGitEnv(site: GitAuth): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
  };

  if (site.auth_type === 'ssh' && site.ssh_private_key) {
    const keyPath = keyPathFor(site.id);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, ensureTrailingNewline(decrypt(site.ssh_private_key)), {
      mode: 0o600,
    });

    const knownHosts = knownHostsPath();
    if (!fs.existsSync(knownHosts)) {
      fs.writeFileSync(knownHosts, '', { mode: 0o600 });
    }

    env.GIT_SSH_COMMAND = [
      'ssh',
      `-i ${shellQuote(keyPath)}`,
      '-o IdentitiesOnly=yes',
      `-o UserKnownHostsFile=${shellQuote(knownHosts)}`,
      '-o StrictHostKeyChecking=accept-new',
      '-o BatchMode=yes',
    ].join(' ');
  }

  if (site.auth_type === 'token' && site.access_token) {
    // GitHub accepts the token as the password with any username; x-access-token
    // is the documented convention and also works for fine-grained tokens.
    const basic = Buffer.from(
      `x-access-token:${decrypt(site.access_token)}`,
    ).toString('base64');

    // Append rather than clobber, in case the caller's environment sets these.
    const index = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
    env.GIT_CONFIG_COUNT = String(index + 1);
    env[`GIT_CONFIG_KEY_${index}`] = 'http.extraHeader';
    env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${basic}`;
  }

  return env;
}

async function git(
  site: SiteRow,
  log: BuildLogger,
  args: string[],
  cwd: string,
): Promise<void> {
  const result = await runStreaming('git', args, {
    cwd,
    env: buildGitEnv(site),
    onStdout: (line) => log.stdout(line),
    onStderr: (line) => log.stderr(line),
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed with exit code ${result.exitCode}`);
  }
}

/**
 * Clones the repo on first run, then hard-resets to the latest commit on the
 * configured branch. Tracked files are reset; ignored files (node_modules,
 * caches) are preserved for faster repeat builds.
 *
 * When `options.commit` is given the working tree is detached at that exact
 * commit instead of the branch tip, so a specific revision can be deployed.
 */
export async function syncRepo(
  site: SiteRow,
  log: BuildLogger,
  options: { commit?: string | null } = {},
): Promise<RepoSyncResult> {
  const repoDir = repoDirFor(site.id);
  const branch = site.branch || 'master';
  const env = buildGitEnv(site);
  let cloned = false;

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    await fsp.rm(repoDir, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(repoDir), { recursive: true });
    log.info(`Cloning ${site.repo_url} …`);
    await git(site, log, ['clone', site.repo_url, repoDir], process.cwd());
    cloned = true;
  }

  log.info(`Fetching origin/${branch} …`);
  await git(site, log, ['fetch', '--prune', 'origin'], repoDir);

  try {
    await capture('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      cwd: repoDir,
      env,
    });
  } catch {
    throw new Error(
      `Branch "${branch}" was not found on the remote. Check the branch name in the site settings.`,
    );
  }

  await git(site, log, ['checkout', '-B', branch, `origin/${branch}`], repoDir);
  await git(site, log, ['reset', '--hard', `origin/${branch}`], repoDir);

  if (options.commit) {
    log.info(`Checking out requested commit ${options.commit} …`);
    await git(site, log, ['checkout', '--detach', options.commit], repoDir);
  }

  await git(site, log, ['clean', '-fd'], repoDir);

  const sha = (
    await capture('git', ['rev-parse', 'HEAD'], { cwd: repoDir, env })
  ).trim();
  const subject = (
    await capture('git', ['log', '-1', '--pretty=%s'], { cwd: repoDir, env })
  ).trim();

  return { sha, subject, cloned };
}

/* -------------------------------------------------------------------------- */
/* Commits                                                                     */
/* -------------------------------------------------------------------------- */

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** Committer date, ISO 8601. */
  date: string;
}

/**
 * Ensures the site's workspace holds a clone of the repository. Cloned without a
 * working checkout — deploys create that themselves — so commits can be listed
 * and resolved before the first deploy.
 */
async function ensureWorkspaceRepo(site: SiteRow): Promise<string> {
  const repoDir = repoDirFor(site.id);
  if (fs.existsSync(path.join(repoDir, '.git'))) return repoDir;

  await fsp.rm(repoDir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(repoDir), { recursive: true });
  await capture(
    'git',
    ['clone', '--no-checkout', '--no-tags', site.repo_url, repoDir],
    { cwd: process.cwd(), env: buildGitEnv(site), timeoutMs: 300_000 },
  );
  return repoDir;
}

/** Fetches every branch, so any branch's commits can be resolved locally. */
async function fetchOriginBranches(site: SiteRow, repoDir: string): Promise<void> {
  await capture('git', ['fetch', '--prune', '--no-tags', 'origin'], {
    cwd: repoDir,
    env: buildGitEnv(site),
    timeoutMs: 180_000,
  });
}

/** The most recent commits on a branch, newest first. */
export async function listBranchCommits(
  site: SiteRow,
  branch: string,
  limit = 10,
): Promise<CommitInfo[]> {
  const repoDir = await ensureWorkspaceRepo(site);
  await fetchOriginBranches(site, repoDir);

  const output = await capture(
    'git',
    [
      'log',
      '-n',
      String(limit),
      '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%cI',
      `refs/remotes/origin/${branch}`,
    ],
    { cwd: repoDir, env: buildGitEnv(site), timeoutMs: 30_000 },
  );

  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', shortSha = '', subject = '', author = '', date = ''] =
        line.split('\x1f');
      return { sha, shortSha, subject, author, date };
    });
}

/**
 * Resolves a user-supplied commit-ish (full or abbreviated sha, tag, or branch)
 * to a commit sha, or null when it does not exist. Fetches first, so a commit
 * that has not been deployed yet can still be resolved.
 */
export async function resolveCommit(
  site: SiteRow,
  ref: string,
): Promise<string | null> {
  try {
    const repoDir = await ensureWorkspaceRepo(site);
    await fetchOriginBranches(site, repoDir);
    const sha = (
      await capture(
        'git',
        ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
        { cwd: repoDir, env: buildGitEnv(site), timeoutMs: 15_000 },
      )
    ).trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  branches: string[];
}

/**
 * Validates that the configured key can actually read the repo. Used by the
 * "Test connection" button before the admin saves/deploys.
 */
export async function testConnection(site: SiteRow): Promise<ConnectionTestResult> {
  const env = buildGitEnv(site);
  try {
    const output = await capture('git', ['ls-remote', '--heads', site.repo_url], {
      cwd: process.cwd(),
      env,
    });
    const branches = output
      .split('\n')
      .map((line) => line.split(/\s+/)[1] ?? '')
      .filter(Boolean)
      .map((ref) => ref.replace('refs/heads/', ''));

    const hasBranch = branches.includes(site.branch);
    return {
      ok: true,
      message: hasBranch
        ? `Connected. Branch "${site.branch}" found (${branches.length} branches).`
        : `Connected, but branch "${site.branch}" was not found. Available: ${branches
            .slice(0, 10)
            .join(', ')}`,
      branches,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the repository. ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
      branches: [],
    };
  }
}

export interface RemoteBranch {
  name: string;
  /** Commit the branch currently points at. */
  sha: string;
}

/**
 * Lists the remote's branches with the commit each points at, in a single
 * `ls-remote`. Powers the branch picker and tells whether a branch (and so a
 * deploy target) exists. Throws when the remote cannot be reached.
 */
export async function listRemoteBranches(
  site: GitAuth & { repo_url: string },
): Promise<RemoteBranch[]> {
  const output = await capture('git', ['ls-remote', '--heads', site.repo_url], {
    cwd: process.cwd(),
    env: buildGitEnv(site),
    timeoutMs: 30_000,
  });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = '', ref = ''] = line.split(/\s+/);
      return { name: ref.replace('refs/heads/', ''), sha };
    })
    .filter(
      (branch) => branch.name.length > 0 && /^[0-9a-f]{7,40}$/i.test(branch.sha),
    );
}

/* -------------------------------------------------------------------------- */
/* Repository validation + package.json discovery                              */
/* -------------------------------------------------------------------------- */

export interface PackageJsonScript {
  /** Script key, e.g. "build". */
  name: string;
  /** Command the script expands to, exactly as written in package.json. */
  command: string;
}

export interface PackageJsonInfo {
  name: string | null;
  /** Declared package manager without its version, e.g. "pnpm". */
  packageManager: string | null;
  scripts: PackageJsonScript[];
}

export interface RepoValidation {
  /** The remote was reachable (and authenticated, when credentials were used). */
  ok: boolean;
  message: string;
  branches: string[];
  /** Whether the configured branch actually exists on the remote. */
  branchFound: boolean;
  /** package.json at the branch head, or null when missing or unreadable. */
  packageJson: PackageJsonInfo | null;
  /** Branch the result actually validated (the chosen one, possibly defaulted). */
  resolvedBranch: string | null;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0] ?? text;
}

function parsePackageJson(raw: string): PackageJsonInfo | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const pkg = data as Record<string, unknown>;

  const scripts: PackageJsonScript[] = [];
  const rawScripts = pkg.scripts;
  if (rawScripts && typeof rawScripts === 'object' && !Array.isArray(rawScripts)) {
    for (const [name, command] of Object.entries(
      rawScripts as Record<string, unknown>,
    )) {
      if (typeof command === 'string' && command.trim()) {
        scripts.push({ name, command });
      }
    }
  }

  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  return {
    name: typeof pkg.name === 'string' ? pkg.name : null,
    packageManager: declared ? (declared.split('@')[0] ?? null) : null,
    scripts,
  };
}

/**
 * Reads package.json from the tip of a branch without cloning the whole repo:
 * initialise an empty repo in a scratch directory, shallow-fetch the single
 * branch, then pull the one file out of the fetched commit. The scratch
 * directory is always removed. Returns null when the file is missing or when
 * the fetch fails.
 */
async function readPackageJsonAtHead(
  site: GitAuth & { repo_url: string; branch: string },
  env: NodeJS.ProcessEnv,
): Promise<PackageJsonInfo | null> {
  const scratch = await fsp.mkdtemp(path.join(WORKSPACES_DIR, 'validate-'));
  try {
    await capture('git', ['init', '-q'], { cwd: scratch, env });
    await capture('git', ['remote', 'add', 'origin', site.repo_url], {
      cwd: scratch,
      env,
    });
    await capture(
      'git',
      ['fetch', '--depth', '1', '--no-tags', 'origin', site.branch],
      { cwd: scratch, env, timeoutMs: 60_000 },
    );
    const raw = await capture('git', ['show', 'FETCH_HEAD:package.json'], {
      cwd: scratch,
      env,
      timeoutMs: 15_000,
    });
    return parsePackageJson(raw);
  } catch {
    return null;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Validates a repository configuration that may not be saved yet: lists the
 * remote's branches and, when the configured branch exists, reports the npm
 * scripts found in its package.json. Powers the "Validate connection" button on
 * the site form so the admin can pick a build command from the real repo.
 */
export async function validateRepo(
  site: GitAuth & { repo_url: string; branch: string },
): Promise<RepoValidation> {
  const env = buildGitEnv(site);

  let branches: string[];
  try {
    const output = await capture('git', ['ls-remote', '--heads', site.repo_url], {
      cwd: process.cwd(),
      env,
      timeoutMs: 60_000,
    });
    branches = output
      .split('\n')
      .map((line) => line.split(/\s+/)[1] ?? '')
      .filter(Boolean)
      .map((ref) => ref.replace('refs/heads/', ''));
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the repository. ${firstLine(error)}`,
      branches: [],
      branchFound: false,
      resolvedBranch: null,
      packageJson: null,
    };
  }

  const requestedBranch = site.branch;
  const branchFound = branches.includes(requestedBranch);
  if (!branchFound) {
    const fallback =
      (branches.includes('main') && 'main') ||
      (branches.includes('master') && 'master') ||
      branches[0] ||
      null;
    if (fallback) {
      const fallbackSite = { ...site, branch: fallback };
      const packageJson = await readPackageJsonAtHead(fallbackSite, env);
      return {
        ok: true,
        message: packageJson
          ? `Connected. "${requestedBranch}" was not found, so validated "${fallback}" instead. Found package.json.`
          : `Connected. "${requestedBranch}" was not found, so validated "${fallback}" instead. No package.json at the repository root.`,
        branches,
        branchFound: true,
        resolvedBranch: fallback,
        packageJson,
      };
    }
    return {
      ok: true,
      message: `Connected, but found no branches on the remote.`,
      branches,
      branchFound: false,
      resolvedBranch: null,
      packageJson: null,
    };
  }

  const packageJson = await readPackageJsonAtHead(site, env);
  return {
    ok: true,
    message: packageJson
      ? `Connected on "${requestedBranch}". Found package.json.`
      : `Connected on "${requestedBranch}". No package.json at the repository root.`,
    branches,
    branchFound: true,
    resolvedBranch: requestedBranch,
    packageJson,
  };
}
