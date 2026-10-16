import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import LogViewer from '../components/LogViewer';
import StatusBadge from '../components/StatusBadge';
import { formatDateTime, formatDuration, shortSha } from '../format';
import type { Deployment } from '../types';

const TERMINAL = new Set(['success', 'failed', 'cancelled']);

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!id) return;
    const result = await api.getDeployment(id);
    setDeployment(result);
    return result;
  }, [id]);

  useEffect(() => {
    let cancelled = false;

    refresh()
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the deployment.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // While the build runs, poll so commit metadata and status stay accurate.
  useEffect(() => {
    if (!deployment || TERMINAL.has(deployment.status)) return;
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [deployment, refresh]);

  if (loading) return <div className="page muted">Loading…</div>;
  if (!deployment) {
    return (
      <div className="page">
        <div className="alert error">{error ?? 'Deployment not found.'}</div>
        <Link className="btn ghost" to="/deployments">
          Back to deployments
        </Link>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="title-row">
            <h1>Deployment</h1>
            <StatusBadge status={deployment.status} />
            {deployment.kind === 'rollback' && (
              <span className="badge muted">rollback</span>
            )}
          </div>
          <p className="muted small">
            <Link className="link" to={`/sites/${deployment.siteId}`}>
              {deployment.siteName ?? deployment.siteId}
            </Link>{' '}
            · <span className="mono">{shortSha(deployment.commitSha)}</span>{' '}
            {deployment.commitMessage ?? ''}
          </p>
        </div>
        <Link className="btn ghost" to={`/sites/${deployment.siteId}`}>
          Open site
        </Link>
      </header>

      {error && <div className="alert error">{error}</div>}
      {deployment.status === 'failed' && deployment.error && (
        <div className="alert error">{deployment.error}</div>
      )}

      <dl className="meta-list inline">
        <div>
          <dt>Queued</dt>
          <dd>{formatDateTime(deployment.queuedAt)}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(deployment.startedAt)}</dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>{formatDateTime(deployment.finishedAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(deployment.durationMs)}</dd>
        </div>
        <div>
          <dt>Triggered by</dt>
          <dd>{deployment.triggeredBy ?? '—'}</dd>
        </div>
      </dl>

      <LogViewer deploymentId={deployment.id} initialStatus={deployment.status} />
    </div>
  );
}
