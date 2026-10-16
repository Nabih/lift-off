import { Router, type Request, type Response } from 'express';
import { MAX_LOG_LINES_PER_DEPLOYMENT } from '../config.js';
import { canAccessSite, requireUser } from '../guards.js';
import { logBus } from '../logbus.js';
import * as store from '../store.js';
import {
  toDeploymentDTO,
  type DeploymentRow,
  type DeploymentStatus,
  type LogLine,
} from '../types.js';

export const deploymentsRouter = Router();

const TERMINAL: ReadonlySet<string> = new Set(['success', 'failed', 'cancelled']);

/**
 * Loads a deployment and checks the caller may see its site. Replies with an
 * error and returns null when access is denied.
 */
function loadDeploymentForRequest(
  req: Request,
  res: Response,
): DeploymentRow | null {
  const deployment = store.getDeployment(req.params.id);
  if (!deployment) {
    res.status(404).json({ error: 'Deployment not found.' });
    return null;
  }
  if (!canAccessSite(requireUser(req), deployment.site_id)) {
    res.status(403).json({ error: 'You do not have access to this deployment.' });
    return null;
  }
  return deployment;
}

deploymentsRouter.get('/', (req, res) => {
  const user = requireUser(req);
  const siteId =
    typeof req.query.siteId === 'string' && req.query.siteId
      ? req.query.siteId
      : undefined;
  const requested = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(requested)
    ? Math.min(200, Math.max(1, Math.trunc(requested)))
    : 50;

  // Deployers only ever see deployments for their assigned sites. Combined with
  // the siteId filter, passing someone else's site id simply yields nothing.
  const restrictSiteIds =
    user.role === 'admin' ? undefined : store.assignedSiteIds(user.id);

  const rows = store.listDeploymentsWithSiteName({
    siteId,
    limit,
    restrictSiteIds,
  });

  res.json({
    deployments: rows.map((row) => ({
      ...toDeploymentDTO(row),
      siteName: row.site_name,
      repoUrl: row.site_repo_url,
    })),
  });
});

deploymentsRouter.get('/:id', (req, res) => {
  const deployment = loadDeploymentForRequest(req, res);
  if (!deployment) return;
  res.json({
    ...toDeploymentDTO(deployment),
    repoUrl: store.getSite(deployment.site_id)?.repo_url ?? null,
  });
});

/** Persisted log lines, for polling or re-rendering history. */
deploymentsRouter.get('/:id/logs', (req, res) => {
  const deployment = loadDeploymentForRequest(req, res);
  if (!deployment) return;

  const afterSeq = Number(req.query.afterSeq ?? 0) || 0;
  const lines = store.getDeploymentLogs(
    deployment.id,
    afterSeq,
    MAX_LOG_LINES_PER_DEPLOYMENT,
  );
  res.json({ lines, status: deployment.status });
});

/**
 * Live build output over Server-Sent Events.
 *
 * Ordering matters here: we subscribe *before* replaying persisted lines, buffer
 * anything that arrives in the meantime, then de-duplicate by sequence number.
 * Without that, a log line written between the DB read and the subscribe would
 * be silently dropped.
 */
deploymentsRouter.get('/:id/stream', (req, res) => {
  const deployment = loadDeploymentForRequest(req, res);
  if (!deployment) return;
  const deploymentId = deployment.id;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let maxSentSeq = 0;
  let closed = false;

  const send = (entry: LogLine): void => {
    if (typeof entry.seq === 'number') {
      if (entry.seq <= maxSentSeq) return;
      maxSentSeq = entry.seq;
    }
    res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  };

  const finish = (status: string): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    res.write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
    res.end();
  };

  let buffering = true;
  const buffer: LogLine[] = [];

  const unsubscribe = logBus.subscribe(
    deploymentId,
    (entry) => {
      if (buffering) buffer.push(entry);
      else send(entry);
    },
    (status) => finish(status),
  );

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);

  for (const line of store.getDeploymentLogs(
    deploymentId,
    0,
    MAX_LOG_LINES_PER_DEPLOYMENT,
  )) {
    send(line);
  }
  buffering = false;
  for (const entry of buffer) send(entry);
  buffer.length = 0;

  if (TERMINAL.has(deployment.status as DeploymentStatus)) {
    finish(deployment.status);
  }

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
});
