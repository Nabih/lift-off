import { MAX_CONCURRENT_BUILDS, repoDirFor } from './config.js';
import { randomId } from './crypto.js';
import {
  deployArtifact,
  releaseNameSha,
  resolveDistDir,
  rollbackRelease,
  switchRelease,
} from './deploy.js';
import { syncRepo } from './git.js';
import { createBuildLogger, type BuildLogger } from './log.js';
import {
  getMailConfig,
  notificationRecipients,
  sendDeploymentFinishedEmail,
} from './mail.js';
import { logBus } from './logbus.js';
import { runStreaming } from './process.js';
import {
  findDeploymentByShaPrefix,
  getDeployment,
  getSite,
  insertDeployment,
  pruneDeployments,
  updateDeployment,
} from './store.js';
import type { DeploymentKind, SiteRow } from './types.js';

/* -------------------------------------------------------------------------- */
/* Queue                                                                       */
/* -------------------------------------------------------------------------- */

const pending: string[] = [];
let active = 0;

export interface EnqueueOptions {
  /** Branch to deploy. Defaults to the site's configured branch. */
  branch?: string | null;
  /** Exact commit to check out; the branch tip is used when omitted. */
  commit?: string | null;
  /** Mark the deployment as a forced re-deploy of what was already live. */
  redeploy?: boolean;
  /**
   * For rollbacks: repoint `current` at this specific release instead of the
   * one immediately before it. Omit for a one-step rollback.
   */
  releaseName?: string | null;
}

function enqueue(
  siteId: string,
  triggeredBy: string,
  kind: DeploymentKind,
  options: EnqueueOptions = {},
): string {
  const site = getSite(siteId);
  if (!site) throw new Error('Site not found.');

  const deploymentId = randomId('dep');
  insertDeployment({
    id: deploymentId,
    site_id: site.id,
    kind,
    status: 'queued',
    branch: options.branch ?? site.branch,
    // The requested commit (already resolved to a full sha) until the deploy
    // records the commit it actually built.
    commit_sha: options.commit ?? null,
    commit_message: null,
    redeploy: options.redeploy ? 1 : 0,
    release_name: options.releaseName ?? null,
    triggered_by: triggeredBy,
    error: null,
    queued_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
  });

  pending.push(deploymentId);
  queueMicrotask(pump);
  return deploymentId;
}

/**
 * Creates a deployment record and schedules it. Builds run one-at-a-time by
 * default (LIFTOFF_MAX_CONCURRENT_BUILDS) so a busy site cannot starve the box.
 */
export function enqueueDeployment(
  siteId: string,
  triggeredBy: string,
  options: EnqueueOptions = {},
): string {
  return enqueue(siteId, triggeredBy, 'deploy', options);
}

/** Queues a rollback of the `current` symlink to the previous (or a specific) release. */
export function enqueueRollback(
  siteId: string,
  triggeredBy: string,
  options: { releaseName?: string | null } = {},
): string {
  return enqueue(siteId, triggeredBy, 'rollback', {
    releaseName: options.releaseName ?? null,
  });
}

/**
 * Emails the configured recipient once a deployment has finished, whatever the
 * outcome. This is deliberately wired into the queue's `finally` rather than the
 * success/failure branches: every deployment passes through exactly once, so a
 * notification cannot be sent twice or skipped on an early exit.
 *
 * Fire-and-forget: a slow or broken SMTP server must never delay the next build.
 */
/** Errors worth retrying: flaky DNS / refused / timed-out SMTP hops. */
function isTransientMailError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EDNS', 'ESOCKET'].includes(code) ||
    /timeout|timed out|ECONNRESET|socket hang up|network|ENOTFOUND/i.test(message)
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Sends with a short retry, since a single DNS hiccup should not lose the mail. */
async function sendWithRetry(
  config: Parameters<typeof sendDeploymentFinishedEmail>[0],
  deployment: Parameters<typeof sendDeploymentFinishedEmail>[1],
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sendDeploymentFinishedEmail(config, deployment);
      return;
    } catch (error) {
      const last = attempt === attempts;
      if (last || !isTransientMailError(error)) throw error;
      await sleep(attempt * 1000);
    }
  }
}

function notifyDeploymentFinished(deploymentId: string): void {
  // Record the outcome in the deployment's log so a missing email is visible in
  // the UI, not just in the server console.
  const log = createBuildLogger(deploymentId);
  try {
    const config = getMailConfig();
    if (!config) return;
    // Opt-in switch.
    if (!config.notifyEnabled) return;

    const deployment = getDeployment(deploymentId);
    if (!deployment) return;
    const status = deployment.status;
    if (status !== 'success' && status !== 'failed' && status !== 'cancelled') {
      return;
    }

    const started = deployment.started_at
      ? Date.parse(deployment.started_at)
      : Number.NaN;
    const finished = deployment.finished_at
      ? Date.parse(deployment.finished_at)
      : Number.NaN;
    const durationMs =
      Number.isFinite(started) && Number.isFinite(finished)
        ? finished - started
        : null;

    void sendWithRetry(config, {
      siteName: getSite(deployment.site_id)?.name ?? deployment.site_id,
      status,
      branch: deployment.branch,
      commitSha: deployment.commit_sha,
      commitMessage: deployment.commit_message,
      triggeredBy: deployment.triggered_by,
      error: deployment.error,
      durationMs,
    })
      .then(() => {
        log.success(`Notification email sent to ${notificationRecipients().join(', ')}`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Could not send the notification email: ${message}`);
        console.error('[liftoff] Could not send the deployment notification:', message);
      });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    createBuildLogger(deploymentId).error(
      `Could not send the notification email: ${message}`,
    );
    console.error('[liftoff] Could not send the deployment notification:', message);
  }
}

function pump(): void {
  while (active < MAX_CONCURRENT_BUILDS && pending.length > 0) {
    const deploymentId = pending.shift();
    if (!deploymentId) break;
    active += 1;
    void runDeployment(deploymentId)
      .catch(() => {
        /* runDeployment records its own failures */
      })
      .finally(() => {
        active -= 1;
        notifyDeploymentFinished(deploymentId);
        pump();
      });
  }
}

export function queueDepth(): number {
  return pending.length + active;
}

/* -------------------------------------------------------------------------- */
/* Build + deploy                                                              */
/* -------------------------------------------------------------------------- */

function buildEnvironment(site: SiteRow): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  try {
    const extra = JSON.parse(site.env_vars) as Record<string, unknown>;
    for (const [key, value] of Object.entries(extra)) {
      env[key] = String(value);
    }
  } catch {
    /* malformed env_vars are ignored; validated on write */
  }
  return env;
}

async function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: BuildLogger,
): Promise<void> {
  log.info(`$ ${command}`);
  const result = await runStreaming(command, [], {
    cwd,
    env,
    shell: true,
    onStdout: (line) => log.stdout(line),
    onStderr: (line) => log.stderr(line),
  });
  if (result.timedOut) {
    throw new Error(`Command timed out: ${command}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Command exited with code ${result.exitCode}: ${command}`,
    );
  }
}

async function runDeployment(deploymentId: string): Promise<void> {
  const deployment = getDeployment(deploymentId);
  if (!deployment) return;

  const site = getSite(deployment.site_id);
  if (!site) {
    updateDeployment(deploymentId, {
      status: 'failed',
      error: 'Site was deleted before the build started.',
      finished_at: new Date().toISOString(),
    });
    return;
  }

  const log = createBuildLogger(deploymentId);
  updateDeployment(deploymentId, {
    status: 'running',
    started_at: new Date().toISOString(),
  });

  try {
    if (!site.enabled) {
      throw new Error('This site is disabled. Enable it before deploying.');
    }

    if (deployment.kind === 'rollback') {
      await performRollback(site, deploymentId, log, deployment.release_name);
    } else {
      // The branch and (optional) commit were chosen when the deploy was queued;
      // they can differ from the site's configured branch.
      await performDeploy(site, deploymentId, log, {
        branch: deployment.branch || site.branch,
        commit: deployment.commit_sha,
      });
    }

    updateDeployment(deploymentId, {
      status: 'success',
      finished_at: new Date().toISOString(),
    });
    logBus.finish(deploymentId, 'success');
    pruneDeployments(site.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(message);
    updateDeployment(deploymentId, {
      status: 'failed',
      error: message,
      finished_at: new Date().toISOString(),
    });
    logBus.finish(deploymentId, 'failed');
  }
}

/** Clone/fetch -> install -> build -> ship the output. */
async function performDeploy(
  site: SiteRow,
  deploymentId: string,
  log: BuildLogger,
  target: { branch: string; commit: string | null },
): Promise<void> {
  log.info(
    `Deploying "${site.name}" from ${site.repo_url} (branch ${target.branch}${
      target.commit ? `, commit ${target.commit.slice(0, 7)}` : ''
    })`,
  );

  // syncRepo checks out the branch it is given, so pass the branch chosen for
  // this deploy rather than the site's configured one.
  const { sha, subject, cloned } = await syncRepo(
    { ...site, branch: target.branch },
    log,
    { commit: target.commit },
  );
  log.info(
    `${cloned ? 'Cloned' : 'Fast-forwarded'} to ${sha.slice(0, 7)} — ${subject}`,
  );
  // Record what we actually built, in case it changed since enqueue.
  updateDeployment(deploymentId, {
    branch: target.branch,
    commit_sha: sha,
    commit_message: subject,
  });

  const repoDir = repoDirFor(site.id);
  const env = buildEnvironment(site);

  if (site.install_command.trim()) {
    await runCommand(site.install_command, repoDir, env, log);
  }
  if (site.build_command.trim()) {
    await runCommand(site.build_command, repoDir, env, log);
  }

  const outputDir = resolveDistDir(repoDir, site.dist_dir);
  log.info(`Using build output at ${site.dist_dir}`);

  const result = await deployArtifact(site, outputDir, sha, log);

  // Remember the release folder so the Releases card can label it (e.g. as a
  // re-deployment). Direct strategy produces no release folder.
  if (result.releaseName) {
    updateDeployment(deploymentId, { release_name: result.releaseName });
  }

  log.success(
    result.strategy === 'releases'
      ? `Deployed to ${result.releaseDir} (current -> this release)`
      : `Deployed to ${result.targetDir}`,
  );
}

async function performRollback(
  site: SiteRow,
  deploymentId: string,
  log: BuildLogger,
  targetRelease?: string | null,
): Promise<void> {
  if (site.deploy_strategy !== 'releases') {
    throw new Error(
      'Rollback is only available for sites using the "releases" deploy strategy.',
    );
  }
  log.info(`Rolling back "${site.name}"`);
  let releaseName: string;
  if (targetRelease) {
    const result = await switchRelease(site.target_dir, targetRelease, log);
    releaseName = result.releaseName;
  } else {
    const result = await rollbackRelease(site.target_dir, log);
    releaseName = result.releaseName;
  }

  const sha7 = releaseNameSha(releaseName);
  const origin = sha7 ? findDeploymentByShaPrefix(site.id, sha7) : null;
  updateDeployment(deploymentId, {
    commit_sha: origin?.commit_sha ?? sha7,
    commit_message: origin?.commit_message ?? null,
    branch: origin?.branch ?? site.branch,
  });

  log.success(`Rolled back: current -> releases/${releaseName}`);
}

export { logBus };
