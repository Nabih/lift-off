import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth.js';
import { WORKSPACES_DIR, keyPathFor } from '../config.js';
import { encrypt, randomId } from '../crypto.js';
import { listReleases, validateTargetDir } from '../deploy.js';
import { resolveRemoteHead, testConnection, validateRepo } from '../git.js';
import { canAccessSite, firstIssue, isAdmin, requireUser } from '../guards.js';
import { enqueueDeployment, enqueueRollback } from '../runner.js';
import { generateSshKeypair } from '../ssh.js';
import * as store from '../store.js';
import { toSiteDTO, type AuthType, type SiteDTO, type SiteRow } from '../types.js';

export const sitesRouter = Router();

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const siteSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  repoUrl: z.string().trim().min(1, 'Repository URL is required.').max(500),
  branch: z.string().trim().min(1, 'Branch is required.').max(200).default('master'),
  authType: z.enum(['ssh', 'token', 'none']).default('ssh'),
  /** Personal access token for `authType: 'token'`. Blank on update keeps the stored one. */
  accessToken: z.string().trim().max(500).optional(),
  installCommand: z.string().max(2000).default('npm ci'),
  buildCommand: z.string().max(2000).default('npm run build'),
  distDir: z.string().trim().min(1, 'Output directory is required.').max(500).default('dist'),
  targetDir: z.string().trim().min(1, 'Target directory is required.').max(1000),
  deployStrategy: z.enum(['releases', 'direct']).default('releases'),
  keepReleases: z.coerce.number().int().min(1).max(50).default(5),
  envVars: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

const SSH_URL = /^(?:ssh:\/\/)?[^\s@/]+@[^\s:/]+:[^\s]+$/;
const SSH_SCHEME_URL = /^ssh:\/\/[^\s]+$/i;
const HTTP_URL = /^https?:\/\/[^\s]+$/i;
const GIT_URL = /^git:\/\/[^\s]+$/i;

function validateRepoUrl(repoUrl: string, authType: AuthType): string | null {
  if (authType === 'ssh') {
    if (SSH_URL.test(repoUrl) || SSH_SCHEME_URL.test(repoUrl)) return null;
    return 'With an SSH deploy key the URL must be SSH form, e.g. git@github.com:owner/repo.git';
  }
  if (authType === 'token') {
    if (HTTP_URL.test(repoUrl)) return null;
    return 'With a personal access token the URL must be an HTTPS URL, e.g. https://github.com/owner/repo.git';
  }
  if (HTTP_URL.test(repoUrl) || GIT_URL.test(repoUrl) || SSH_URL.test(repoUrl)) {
    return null;
  }
  return 'Enter a valid repository URL.';
}

function validateDistDir(distDir: string): string | null {
  const cleaned = distDir.trim();
  if (!cleaned) return 'Output directory is required.';
  if (path.isAbsolute(cleaned)) {
    return 'Output directory must be relative to the repository (e.g. "dist").';
  }
  if (cleaned.split(/[\\/]+/).includes('..')) {
    return 'Output directory cannot contain "..".';
  }
  return null;
}

function validateSiteConfig(config: {
  repoUrl: string;
  authType: AuthType;
  hasAccessToken: boolean;
  distDir: string;
  targetDir: string;
}): string | null {
  const repoProblem = validateRepoUrl(config.repoUrl, config.authType);
  if (repoProblem) return repoProblem;
  if (config.authType === 'token' && !config.hasAccessToken) {
    return 'A personal access token is required for token authentication.';
  }
  const distProblem = validateDistDir(config.distDir);
  if (distProblem) return distProblem;
  try {
    validateTargetDir(config.targetDir);
  } catch (error) {
    return (error as Error).message;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Access helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Deployers can see a site but not its build secrets, so env var *values* are
 * blanked while the names stay visible.
 */
function siteForUser(row: SiteRow, user: AuthUser): SiteDTO {
  const dto = toSiteDTO(row);
  if (!isAdmin(user)) {
    dto.envVars = Object.fromEntries(
      Object.keys(dto.envVars).map((key) => [key, '']),
    );
  }
  return dto;
}

function denyNonAdmin(res: Response): void {
  res
    .status(403)
    .json({ error: 'Administrator access is required for this action.' });
}

/**
 * Loads the site for a read/operate route and enforces access. Replies with an
 * error and returns null when the caller may not proceed.
 */
function loadSiteForRequest(req: Request, res: Response): SiteRow | null {
  const site = store.getSite(req.params.id);
  if (!site) {
    res.status(404).json({ error: 'Site not found.' });
    return null;
  }
  if (!canAccessSite(requireUser(req), site.id)) {
    res.status(403).json({ error: 'You do not have access to this site.' });
    return null;
  }
  return site;
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

sitesRouter.get('/', (req, res) => {
  const user = requireUser(req);
  res.json({
    sites: store
      .listSitesForUser(user.id, isAdmin(user))
      .map((row) => siteForUser(row, user)),
  });
});

sitesRouter.get('/:id', (req, res) => {
  const site = loadSiteForRequest(req, res);
  if (!site) return;
  res.json(siteForUser(site, requireUser(req)));
});

sitesRouter.post('/', async (req, res, next) => {
  try {
    if (!isAdmin(requireUser(req))) {
      denyNonAdmin(res);
      return;
    }

    const parsed = siteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    const data = parsed.data;

    const problem = validateSiteConfig({
      ...data,
      hasAccessToken: Boolean(data.accessToken),
    });
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }

    // Every SSH site gets its own keypair; the private half is encrypted at rest.
    const keypair =
      data.authType === 'ssh'
        ? await generateSshKeypair(`liftoff:${data.name}`)
        : null;

    const now = new Date().toISOString();
    const row: SiteRow = {
      id: randomId('site'),
      name: data.name,
      repo_url: data.repoUrl,
      branch: data.branch,
      auth_type: data.authType,
      ssh_private_key: keypair ? encrypt(keypair.privateKey) : null,
      ssh_public_key: keypair ? keypair.publicKey : null,
      access_token: data.accessToken ? encrypt(data.accessToken) : null,
      install_command: data.installCommand,
      build_command: data.buildCommand,
      dist_dir: data.distDir,
      target_dir: data.targetDir,
      deploy_strategy: data.deployStrategy,
      keep_releases: data.keepReleases,
      env_vars: JSON.stringify(data.envVars),
      enabled: data.enabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    };

    store.insertSite(row);
    res.status(201).json(toSiteDTO(store.getSite(row.id)!));
  } catch (error) {
    next(error);
  }
});

sitesRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!isAdmin(requireUser(req))) {
      denyNonAdmin(res);
      return;
    }

    const existing = store.getSite(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Site not found.' });
      return;
    }

    const parsed = siteSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    const data = parsed.data;

    // Validate the *merged* result so partial updates cannot create an invalid
    // combination (e.g. switching auth type without changing the URL).
    const current = toSiteDTO(existing);
    const problem = validateSiteConfig({
      repoUrl: data.repoUrl ?? current.repoUrl,
      authType: data.authType ?? current.authType,
      hasAccessToken: data.accessToken ? true : current.hasAccessToken,
      distDir: data.distDir ?? current.distDir,
      targetDir: data.targetDir ?? current.targetDir,
    });
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.repoUrl !== undefined) patch.repo_url = data.repoUrl;
    if (data.branch !== undefined) patch.branch = data.branch;
    if (data.authType !== undefined) patch.auth_type = data.authType;
    if (data.installCommand !== undefined) patch.install_command = data.installCommand;
    if (data.buildCommand !== undefined) patch.build_command = data.buildCommand;
    if (data.distDir !== undefined) patch.dist_dir = data.distDir;
    if (data.targetDir !== undefined) patch.target_dir = data.targetDir;
    if (data.deployStrategy !== undefined) patch.deploy_strategy = data.deployStrategy;
    if (data.keepReleases !== undefined) patch.keep_releases = data.keepReleases;
    if (data.envVars !== undefined) patch.env_vars = JSON.stringify(data.envVars);
    if (data.enabled !== undefined) patch.enabled = data.enabled ? 1 : 0;

    // Blank means "leave the stored token alone", so the UI can submit the form
    // without ever holding the secret.
    if (data.accessToken) patch.access_token = encrypt(data.accessToken);

    // Switching to SSH on a keyless site provisions a key on the spot.
    const switchingToSsh = data.authType === 'ssh' && !existing.ssh_private_key;
    if (switchingToSsh) {
      const keypair = await generateSshKeypair(
        `liftoff:${data.name ?? existing.name}`,
      );
      patch.ssh_private_key = encrypt(keypair.privateKey);
      patch.ssh_public_key = keypair.publicKey;
    }

    store.updateSite(existing.id, patch);
    res.json(toSiteDTO(store.getSite(existing.id)!));
  } catch (error) {
    next(error);
  }
});

sitesRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!isAdmin(requireUser(req))) {
      denyNonAdmin(res);
      return;
    }

    const site = store.getSite(req.params.id);
    if (!site) {
      res.status(404).json({ error: 'Site not found.' });
      return;
    }
    store.deleteSite(site.id);
    await Promise.allSettled([
      fsp.rm(path.join(WORKSPACES_DIR, site.id), { recursive: true, force: true }),
      fsp.rm(keyPathFor(site.id), { force: true }),
    ]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** Issues a fresh keypair, invalidating the old deploy key on GitHub. */
sitesRouter.post('/:id/ssh-key', async (req, res, next) => {
  try {
    if (!isAdmin(requireUser(req))) {
      denyNonAdmin(res);
      return;
    }

    const site = store.getSite(req.params.id);
    if (!site) {
      res.status(404).json({ error: 'Site not found.' });
      return;
    }
    const keypair = await generateSshKeypair(`liftoff:${site.name}`);
    store.updateSite(site.id, {
      auth_type: 'ssh',
      ssh_private_key: encrypt(keypair.privateKey),
      ssh_public_key: keypair.publicKey,
    });
    res.json(toSiteDTO(store.getSite(site.id)!));
  } catch (error) {
    next(error);
  }
});

const accessSchema = z.object({
  /** Deployer user ids that should have access to this site. */
  userIds: z.array(z.string()).default([]),
});

/**
 * Replaces which Deployers can reach a site. Admins always have access, so only
 * Deployer ids are stored. Admin-only, like every other site mutation.
 */
sitesRouter.put('/:id/access', (req, res) => {
  if (!isAdmin(requireUser(req))) {
    denyNonAdmin(res);
    return;
  }
  const site = store.getSite(req.params.id);
  if (!site) {
    res.status(404).json({ error: 'Site not found.' });
    return;
  }
  const parsed = accessSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  store.setSiteUsers(site.id, parsed.data.userIds);
  res.json({ ok: true, userIds: store.assignedUserIds(site.id) });
});

sitesRouter.post('/:id/test', async (req, res, next) => {
  try {
    const site = loadSiteForRequest(req, res);
    if (!site) return;
    res.json(await testConnection(site));
  } catch (error) {
    next(error);
  }
});

const validateSchema = z.object({
  siteId: z.string().trim().optional(),
  repoUrl: z.string().trim().min(1, 'Repository URL is required.').max(500),
  branch: z.string().trim().min(1, 'Branch is required.').max(200).default('master'),
  authType: z.enum(['ssh', 'token', 'none']).default('ssh'),
  accessToken: z.string().trim().max(500).optional(),
});

/**
 * Validates a repository configuration straight from the site form, before it
 * is saved, and reports the npm scripts in the branch's package.json. Admin-only
 * because editing sites is an admin action and the request may carry a token.
 */
sitesRouter.post('/validate', async (req, res, next) => {
  try {
    if (!isAdmin(requireUser(req))) {
      denyNonAdmin(res);
      return;
    }

    const parsed = validateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    const data = parsed.data;

    // A token typed into the form wins; otherwise fall back to the stored one,
    // so an unchanged secret never has to travel back to the browser.
    const existing = data.siteId ? store.getSite(data.siteId) : undefined;
    const accessToken = data.accessToken
      ? encrypt(data.accessToken)
      : (existing?.access_token ?? null);
    const sshPrivateKey = existing?.ssh_private_key ?? null;

    if (data.authType === 'token' && !accessToken) {
      res.json({
        ok: false,
        message: 'Enter a personal access token to validate the connection.',
        branches: [],
        branchFound: false,
        packageJson: null,
      });
      return;
    }

    if (data.authType === 'ssh' && !sshPrivateKey) {
      res.json({
        ok: false,
        message:
          'SSH sites authenticate with a deploy key that is generated when the site is saved. Save the site, add its public key to the repository, then validate.',
        branches: [],
        branchFound: false,
        packageJson: null,
      });
      return;
    }

    res.json(
      await validateRepo({
        id: existing?.id ?? 'validate',
        repo_url: data.repoUrl,
        branch: data.branch,
        auth_type: data.authType,
        ssh_private_key: sshPrivateKey,
        access_token: accessToken,
      }),
    );
  } catch (error) {
    next(error);
  }
});

/** Compares two commit shas when one may be abbreviated (7 chars from a release name). */
function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const length = Math.min(a.length, b.length);
  return a.slice(0, length).toLowerCase() === b.slice(0, length).toLowerCase();
}

/**
 * Describes what a deploy of this site would do: the branch and commit that are
 * currently live, the remote's head for the configured branch, and whether the
 * two are the same (which makes a deploy a no-op unless it is forced).
 *
 * The remote lookup needs the network, so a failure leaves `remoteSha` null and
 * `wouldRedeploy` false — the deploy itself is then free to fail with a clearer
 * message rather than being blocked here.
 */
async function buildDeployCheck(site: SiteRow) {
  const live = store.getLiveDeployment(site.id);
  const remoteSha = await resolveRemoteHead(site);
  const branchMatches = Boolean(live && live.branch === site.branch);
  const commitMatches = Boolean(live && sameCommit(live.commit_sha, remoteSha));
  return {
    branch: site.branch,
    live: live
      ? { branch: live.branch, commitSha: live.commit_sha }
      : null,
    remoteSha,
    wouldRedeploy: branchMatches && commitMatches,
  };
}

sitesRouter.get('/:id/deploy-check', async (req, res, next) => {
  try {
    const site = loadSiteForRequest(req, res);
    if (!site) return;
    res.json(await buildDeployCheck(site));
  } catch (error) {
    next(error);
  }
});

sitesRouter.post('/:id/deploy', async (req, res, next) => {
  try {
    const site = loadSiteForRequest(req, res);
    if (!site) return;
    if (!site.enabled) {
      res.status(409).json({ error: 'This site is disabled.' });
      return;
    }

    const force = Boolean((req.body as { force?: unknown } | undefined)?.force);
    const check = await buildDeployCheck(site);
    if (check.wouldRedeploy && !force) {
      res.status(409).json({
        error:
          `Branch "${site.branch}" and commit ` +
          `${check.remoteSha?.slice(0, 7) ?? ''} are already live. ` +
          'Tick Force deploy to redeploy them anyway.',
        code: 'ALREADY_LIVE',
        check,
      });
      return;
    }

    const deploymentId = enqueueDeployment(site.id, requireUser(req).username, {
      branch: site.branch,
      redeploy: check.wouldRedeploy,
    });
    res.status(202).json({ deploymentId });
  } catch (error) {
    next(error);
  }
});

sitesRouter.post('/:id/rollback', (req, res) => {
  const site = loadSiteForRequest(req, res);
  if (!site) return;
  if (site.deploy_strategy !== 'releases') {
    res.status(409).json({
      error: 'Rollback requires the "releases" deploy strategy.',
    });
    return;
  }
  const deploymentId = enqueueRollback(site.id, requireUser(req).username);
  res.status(202).json({ deploymentId });
});

sitesRouter.get('/:id/releases', async (req, res, next) => {
  try {
    const site = loadSiteForRequest(req, res);
    if (!site) return;
    if (site.deploy_strategy !== 'releases') {
      res.json({ releases: [] });
      return;
    }
    res.json({ releases: await listReleases(site.target_dir) });
  } catch (error) {
    next(error);
  }
});
