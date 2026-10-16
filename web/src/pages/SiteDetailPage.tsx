import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import CommitRef from '../components/CommitRef';
import CopyButton from '../components/CopyButton';
import StatusBadge from '../components/StatusBadge';
import { formatDateTime, formatDuration, formatRelative, shortSha } from '../format';
import type { ConnectionTest, DeployCheck, Deployment, Release, Site } from '../types';

/** The pre-deploy confirmation, including whether a force is required. */
interface DeployDialogState {
  check: DeployCheck | null;
  checking: boolean;
  force: boolean;
}

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
  const [deployDialog, setDeployDialog] = useState<DeployDialogState | null>(null);

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

  /**
   * A deploy is never immediate: this always opens a confirmation. It asks the
   * server whether the branch and commit are already live so it can require a
   * deliberate force before re-deploying them.
   */
  async function openDeployDialog() {
    if (!site) return;
    setDeployDialog({ check: null, checking: true, force: false });
    let check: DeployCheck | null = null;
    try {
      check = await api.deployCheck(site.id);
    } catch {
      // The check needs the network. If it fails we still confirm; the deploy
      // endpoint re-checks and rejects an accidental re-deploy with a clear
      // message rather than silently blocking.
    }
    setDeployDialog({ check, checking: false, force: false });
  }

  async function confirmDeploy() {
    if (!site || !deployDialog) return;
    const { force } = deployDialog;
    await run('deploy', async () => {
      try {
        const { deploymentId } = await api.deploySite(site.id, force);
        setDeployDialog(null);
        navigate(`/deployments/${deploymentId}`);
      } catch (err) {
        // A 409 means it turned out to be a re-deploy (e.g. the check was
        // stale). Keep the dialog open and surface the force option.
        if (err instanceof ApiError && err.status === 409) {
          const check = await api.deployCheck(site.id).catch(() => null);
          setDeployDialog({ check, checking: false, force: false });
        }
        throw err;
      }
    });
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
        <div>
          <div className="title-row">
            <h1>{site.name}</h1>
            {!site.enabled && <span className="badge muted">disabled</span>}
          </div>
          <p className="mono muted small">{site.repoUrl}</p>
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
          ) : site.authType === 'token' ? (
            <>
              <p className="muted small">
                Clones over HTTPS with a personal access token{' '}
                {site.hasAccessToken ? (
                  <span className="badge muted">stored, encrypted</span>
                ) : (
                  <span className="badge failed">missing</span>
                )}
                . For safety the token is never sent back to the browser after it is
                saved.
              </p>
              {isAdmin && (
                <p className="muted small">
                  Replace it from <Link to={`/sites/${site.id}/edit`}>Edit</Link> if it
                  expires or is revoked on GitHub.
                </p>
              )}
            </>
          ) : (
            <p className="muted small">
              This site clones over HTTPS without credentials and is only suitable
              for public repositories.
            </p>
          )}
        </section>
      </div>

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
              <li key={release.name} className={release.isCurrent ? 'current' : ''}>
                <span className="mono">{release.name}</span>
                {release.isCurrent && <span className="badge success">live</span>}
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
                      <span className="badge queued">re-deployment</span>
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
                    <Link className="link" to={`/deployments/${deployment.id}`}>
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

      {deployDialog && (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={() => {
            if (busy === null) setDeployDialog(null);
          }}
        >
          <div
            className="modal card"
            role="dialog"
            aria-modal="true"
            aria-label={`Deploy ${site.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <h2>Deploy “{site.name}”?</h2>

            {deployDialog.checking ? (
              <p className="muted small">Checking the repository…</p>
            ) : (
              <dl className="meta-list inline">
                <div>
                  <dt>Branch</dt>
                  <dd className="mono">{site.branch}</dd>
                </div>
                <div>
                  <dt>Remote head</dt>
                  <dd className="mono" title={deployDialog.check?.remoteSha ?? ''}>
                    {deployDialog.check?.remoteSha
                      ? shortSha(deployDialog.check.remoteSha)
                      : 'unknown'}
                  </dd>
                </div>
                <div>
                  <dt>Live</dt>
                  <dd className="mono" title={deployDialog.check?.live?.commitSha ?? ''}>
                    {deployDialog.check?.live?.commitSha
                      ? shortSha(deployDialog.check.live.commitSha)
                      : 'nothing yet'}
                  </dd>
                </div>
              </dl>
            )}

            {deployDialog.check?.wouldRedeploy && (
              <>
                <div className="alert warning">
                  Branch “{site.branch}” at commit{' '}
                  {shortSha(deployDialog.check.remoteSha)} is already live.
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={deployDialog.force}
                    onChange={(event) => {
                      const { checked } = event.target;
                      setDeployDialog((current) =>
                        current ? { ...current, force: checked } : current,
                      );
                    }}
                  />
                  Force deploy (re-deploy the live branch and commit)
                </label>
              </>
            )}

            <div className="form-actions">
              <button
                className="btn ghost"
                type="button"
                disabled={busy !== null}
                onClick={() => setDeployDialog(null)}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={
                  busy !== null ||
                  deployDialog.checking ||
                  Boolean(deployDialog.check?.wouldRedeploy && !deployDialog.force)
                }
                onClick={() => void confirmDeploy()}
              >
                {busy === 'deploy'
                  ? 'Starting…'
                  : deployDialog.check?.wouldRedeploy
                    ? 'Force deploy'
                    : 'Deploy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
