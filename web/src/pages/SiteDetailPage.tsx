import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import CommitRef from '../components/CommitRef';
import CopyButton from '../components/CopyButton';
import DeployDialog from '../components/DeployDialog';
import StatusBadge from '../components/StatusBadge';
import { formatDateTime, formatDuration, formatRelative, shortSha } from '../format';
import type {
  ConnectionTest,
  Deployment,
  Release,
  Site,
} from '../types';

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  const [site, setSite] = useState<Site | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deployTarget, setDeployTarget] = useState<Site | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const loaded = await api.getSite(id);
    setSite(loaded);

    const [deploymentResult, releaseResult] = await Promise.all([
      api.listDeployments(id, 20),
      loaded.deployStrategy === 'releases'
        ? api.listReleases(id).catch(() => ({ releases: [] as Release[] }))
        : Promise.resolve({ releases: [] as Release[] }),
    ]);
    setDeployments(deploymentResult.deployments);
    setReleases(releaseResult.releases);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the site.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  function openDeployDialog() {
    if (!site) return;
    setDeployTarget(site);
  }

  if (loading) return <div className="page muted">Loading…</div>;
  if (!site) {
    return (
      <div className="page">
        <div className="alert error">{error ?? 'Site not found.'}</div>
        <Link className="btn ghost" to="/">
          Back to sites
        </Link>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div className="title-row">
          <h1>{site.name}</h1>
          {!site.enabled && <span className="badge muted">disabled</span>}
        </div>
        <div className="header-actions">
          {isAdmin && (
            <Link className="btn ghost" to={`/sites/${site.id}/edit`}>
              Edit
            </Link>
          )}
          {site.deployStrategy === 'releases' && (
            <button
              className="btn ghost"
              type="button"
              disabled={releases.length < 2 || busy !== null}
              onClick={() =>
                void run('rollback', async () => {
                  const { deploymentId } = await api.rollbackSite(site.id);
                  navigate(`/deployments/${deploymentId}`);
                })
              }
            >
              Roll back
            </button>
          )}
          <button
            className="btn primary"
            type="button"
            disabled={!site.enabled || busy !== null}
            onClick={() => void openDeployDialog()}
          >
            Deploy now
          </button>
        </div>
      </header>

      {error && <div className="alert error">{error}</div>}

      <div className="detail-grid">
        <section className="card">
          <h2>Configuration</h2>
          <dl className="meta-list">
            <div>
              <dt>Branch</dt>
              <dd className="mono">{site.branch}</dd>
            </div>
            <div>
              <dt>Install</dt>
              <dd className="mono">{site.installCommand || '—'}</dd>
            </div>
            <div>
              <dt>Build</dt>
              <dd className="mono">{site.buildCommand || '—'}</dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd className="mono">{site.distDir}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd className="mono">{site.targetDir}</dd>
            </div>
            <div>
              <dt>Strategy</dt>
              <dd>
                {site.deployStrategy === 'releases'
                  ? `releases (keep ${site.keepReleases})`
                  : 'direct'}
              </dd>
            </div>
            {site.deployStrategy === 'releases' && (
              <div>
                <dt>Served from</dt>
                <dd className="mono">{site.targetDir}/current</dd>
              </div>
            )}
            {Object.keys(site.envVars).length > 0 && (
              <div>
                <dt>Env vars</dt>
                <dd className="mono small">
                  {Object.keys(site.envVars).join(', ')}
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section className="card">
          <h2>Authentication</h2>
          {site.authType === 'ssh' && site.sshPublicKey ? (
            <>
              <p className="muted small">
                Add this public key to the repository as a <strong>deploy key</strong>{' '}
                with read access (GitHub → Settings → Deploy keys).
              </p>
              <textarea
                className="input mono key-box"
                readOnly
                rows={3}
                value={site.sshPublicKey}
              />
              <div className="row">
                <CopyButton value={site.sshPublicKey} label="Copy public key" />
                {isAdmin && (
                  <button
                    className="btn ghost small"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      if (
                        !window.confirm(
                          'Generate a new keypair? The old key stops working immediately and must be replaced on GitHub.',
                        )
                      ) {
                        return;
                      }
                      void run('key', async () => {
                        await api.regenerateSshKey(site.id);
                        setTest(null);
                        await load();
                      });
                    }}
                  >
                    Regenerate key
                  </button>
                )}
              </div>
            </>
          ) : null}
        </section>

        <section className="card">
          <div className="row">
            <h2>Connectivity</h2>
            <span className="spacer" />
            <button
              className="btn small"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run('test', async () => {
                  setTest(await api.testSite(site.id));
                })
              }
            >
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          {test ? (
            <div className={`alert ${test.ok ? 'success' : 'error'}`}>{test.message}</div>
          ) : (
            <p className="muted small">
              Verifies the deploy key can read the repository and that the branch
              exists.
            </p>
          )}
        </section>

        {site.deployStrategy === 'releases' && releases.length > 0 && (
          <section className="card">
            <h2>Releases</h2>
            <ul className="release-list">
              {releases.map((release) => (
                <li
                  key={release.name}
                  className={release.isCurrent ? 'current' : ''}
                >
                  <span className="mono">{release.name}</span>
                  {release.isCurrent && <span className="badge success">live</span>}
                  {release.redeploy && (
                    <span className="redeploy-ref" title="A forced re-deploy of what was already live">
                      <span aria-hidden="true">↻</span>
                      <span>re-deploy</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card">
          <div className="row">
            <h2>Recent deployments</h2>
            <span className="spacer" />
            <Link className="btn ghost small" to="/deployments">
              View all
            </Link>
          </div>

          {deployments.length === 0 ? (
            <p className="muted small">No deployments yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
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
                      {deployment.kind === 'rollback' && (
                        <span className="badge muted">rollback</span>
                      )}
                      {deployment.redeploy && (
                        <span
                          className="redeploy-ref"
                          title="A forced re-deploy of what was already live"
                        >
                          <span aria-hidden="true">↻</span>
                          <span>re-deploy</span>
                        </span>
                      )}
                    </td>
                    <td className="small">
                      <CommitRef deployment={deployment} />
                    </td>
                    <td className="small" title={formatDateTime(deployment.queuedAt)}>
                      {formatRelative(deployment.queuedAt)}
                    </td>
                    <td className="small">{formatDuration(deployment.durationMs)}</td>
                    <td>
                      <Link
                        className="link"
                        to={`/deployments/${deployment.id}`}
                      >
                        Logs
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {isAdmin && (
          <section className="card danger-zone">
            <h2>Danger zone</h2>
            <p className="muted small">
              Deleting a site removes its configuration, its local clone, and any user
              assignments. Files already deployed to the target directory are left
              untouched.
            </p>
            <button
              className="btn danger"
              type="button"
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`Delete "${site.name}"? This cannot be undone.`)) return;
                void run('delete', async () => {
                  await api.deleteSite(site.id);
                  navigate('/');
                });
              }}
            >
              Delete site
            </button>
          </section>
        )}
      </div>

      {deployTarget && (
        <DeployDialog
          site={deployTarget}
          onClose={() => setDeployTarget(null)}
          onDeployed={(id) => navigate(`/deployments/${id}`)}
        />
      )}
    </div>
  );
}