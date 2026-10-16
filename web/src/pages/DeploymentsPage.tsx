import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import CommitRef from '../components/CommitRef';
import ErrorAlert from '../components/ErrorAlert';
import StatusBadge from '../components/StatusBadge';
import { formatDateTime, formatDuration, formatRelative } from '../format';
import type { Deployment } from '../types';

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await api.listDeployments(undefined, 100);
        if (!cancelled) setDeployments(result.deployments);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load deployments.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Deployments</h1>
          <p className="muted">Every build and rollback, newest first.</p>
        </div>
      </header>

      {error && <ErrorAlert message={error} />}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : deployments.length === 0 ? (
        <div className="card empty-state">
          <p className="muted">No deployments yet.</p>
        </div>
      ) : (
        <section className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Site</th>
                <th>Commit</th>
                <th>Started</th>
                <th>Duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deployments.map((deployment) => (
                <tr key={deployment.id}>
                  <td>
                    <StatusBadge status={deployment.status} />
                  </td>
                  <td>
                    <Link className="link" to={`/sites/${deployment.siteId}`}>
                      {deployment.siteName ?? deployment.siteId}
                    </Link>
                    {deployment.kind === 'rollback' && (
                      <span className="badge muted">rollback</span>
                    )}
                  </td>
                  <td className="small">
                    <CommitRef deployment={deployment} messageLength={40} />
                  </td>
                  <td className="small" title={formatDateTime(deployment.queuedAt)}>
                    {formatRelative(deployment.queuedAt)}
                  </td>
                  <td className="small">{formatDuration(deployment.durationMs)}</td>
                  <td>
                    <Link className="link" to={`/deployments/${deployment.id}`}>
                      Logs
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
