import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import CommitRef from '../components/CommitRef';
import CopyButton from '../components/CopyButton';
import StatusBadge from '../components/StatusBadge';
import { formatDateTime, formatDuration, formatRelative, shortSha } from '../format';
import type {
  ConnectionTest,
  DeployCheck,
  Deployment,
  Release,
  RemoteCommit,
  Site,
} from '../types';

/** The pre-deploy confirmation: choose a branch/commit and see whether it is valid. */
interface DeployDialogState {
  branch: string;
  /** The optional "Commit" toggle; the picker only shows once it is on. */
  commitEnabled: boolean;
  /** Raw text of the commit field — a sha, but anything can be typed. */
  commit: string;
  /** Commit suggestions for the picker. */
  commits: RemoteCommit[];
  commitsLoading: boolean;
  check: DeployCheck | null;
  /** The check request itself failed (as opposed to the repo being unreachable). */
  checkError: string | null;
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
  /** Monotonic id so a slow check cannot overwrite a newer one. */
  const checkRequest = useRef(0);

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
   * Validates a branch (and optional commit) against the remote. Slow responses
   * are dropped so a stale result cannot overwrite a newer one.
   */
  async function runCheck(branch: string, commit: string) {
    if (!site) return;
    const requestId = (checkRequest.current += 1);
    setDeployDialog((current) => (current ? { ...current, checking: true } : current));
    try {
      const check = await api.deployCheck(site.id, {
        branch,
        commit: commit.trim() || undefined,
      });
      if (requestId !== checkRequest.current) return;
      setDeployDialog((current) =>
        current ? { ...current, check, checking: false, checkError: null } : current,
      );
    } catch (err) {
      if (requestId !== checkRequest.current) return;
      setDeployDialog((current) =>
        current
          ? {
              ...current,
              check: null,
              checking: false,
              checkError: err instanceof Error ? err.message : 'Check failed.',
            }
          : current,
      );
    }
  }

  // Re-check whenever the target changes. Debounced so typing a commit id does
  // not fire a request per keystroke. Deliberately keyed on the branch/commit
  // only — updating `check`/`checking` must not re-trigger it.
  useEffect(() => {
    if (!deployDialog || !site) return;
    const handle = window.setTimeout(() => {
      void runCheck(
        deployDialog.branch,
        deployDialog.commitEnabled ? deployDialog.commit : '',
      );
    }, 300);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    deployDialog?.branch,
    deployDialog?.commit,
    deployDialog?.commitEnabled,
    site?.id,
  ]);

  /** Loads the recent commits for the picker. */
  async function loadCommits(branch: string) {
    if (!site) return;
    setDeployDialog((current) =>
      current ? { ...current, commitsLoading: true } : current,
    );
    try {
      const { commits } = await api.listCommits(site.id, branch);
      setDeployDialog((current) =>
        current && current.branch === branch
          ? { ...current, commits, commitsLoading: false }
          : current,
      );
    } catch {
      setDeployDialog((current) =>
        current ? { ...current, commits: [], commitsLoading: false } : current,
      );
    }
  }

  /** A deploy is never immediate: this always opens the confirmation dialog. */
  function openDeployDialog() {
    if (!site) return;
    setDeployDialog({
      branch: site.branch,
      commitEnabled: false,
      commit: '',
      commits: [],
      commitsLoading: false,
      check: null,
      checkError: null,
      checking: true,
      force: false,
    });
  }

  function pickBranch(branch: string) {
    if (branch === deployDialog?.branch) return;
    // A commit belongs to a branch, so switching branch clears it.
    setDeployDialog((current) =>
      current ? { ...current, branch, commit: '', force: false } : current,
    );
    if (deployDialog?.commitEnabled) void loadCommits(branch);
  }

  function toggleCommit(enabled: boolean) {
    setDeployDialog((current) =>
      current
        ? {
            ...current,
            commitEnabled: enabled,
            commit: enabled ? current.commit : '',
            force: false,
          }
        : current,
    );
    if (enabled && deployDialog) void loadCommits(deployDialog.branch);
  }

  function setCommit(value: string) {
    setDeployDialog((current) =>
      current ? { ...current, commit: value, force: false } : current,
    );
  }

  async function confirmDeploy() {
    if (!site || !deployDialog) return;
    const { branch, commitEnabled, commit, force } = deployDialog;
    const commitValue = commitEnabled ? commit.trim() : '';
    await run('deploy', async () => {
      try {
        const { deploymentId } = await api.deploySite(site.id, {
          branch,
          commit: commitValue || undefined,
          force,
        });
        setDeployDialog(null);
        navigate(`/deployments/${deploymentId}`);
      } catch (err) {
        // A 409 means the server disagreed with our check (e.g. a race).
        // Re-check so the dialog reflects the current state.
        if (err instanceof ApiError && err.status === 409) {
          void runCheck(branch, commitValue);
        }
        throw err;
      }
    });
  }

  // Status icon tone: green when the branch/commit check passes, red when it
  // fails or the repo is unreachable, grey while idle or checking.
  const deployTone: 'idle' | 'ok' | 'error' = !deployDialog
    ? 'idle'
    : deployDialog.checking
      ? 'idle'
      : deployDialog.check?.status === 'ok'
        ? 'ok'
        : deployDialog.check || deployDialog.checkError
          ? 'error'
          : 'idle';
  const deployMessage = !deployDialog
    ? ''
    : deployDialog.checking
      ? 'Checking…'
      : (deployDialog.check?.message ??
        deployDialog.checkError ??
        'Not checked yet.');

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
                {release.redeploy && (
                  <span
                    className="redeploy-ref"
                    title="Re-deployment — this branch and commit were already live"
                  >
                    ↻ re-deploy
                  </span>
                )}
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

            <label className="field">
              <span>Branch</span>
              <select
                className="input mono"
                value={deployDialog.branch}
                onChange={(event) => pickBranch(event.target.value)}
              >
                {!deployDialog.check?.branches.includes(deployDialog.branch) && (
                  <option value={deployDialog.branch}>{deployDialog.branch}</option>
                )}
                {(deployDialog.check?.branches ?? []).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={deployDialog.commitEnabled}
                onChange={(event) => toggleCommit(event.target.checked)}
              />
              Commit
            </label>

            {deployDialog.commitEnabled && (
              <label className="field">
                <span>Commit</span>
                <input
                  className="input mono"
                  list="deploy-commit-options"
                  value={deployDialog.commit}
                  autoComplete="off"
                  placeholder="Branch tip (leave blank) or a commit id"
                  onChange={(event) => setCommit(event.target.value)}
                />
                <datalist id="deploy-commit-options">
                  {deployDialog.commits.map((entry) => (
                    <option key={entry.sha} value={entry.sha}>
                      {entry.shortSha} · {entry.subject}
                    </option>
                  ))}
                </datalist>
                <small className="hint">
                  {deployDialog.commitsLoading
                    ? 'Loading recent commits…'
                    : deployDialog.commits.length > 0
                      ? `Last ${deployDialog.commits.length} commit${
                          deployDialog.commits.length === 1 ? '' : 's'
                        } on ${deployDialog.branch}. Pick one or type your own id.`
                      : 'Type a commit id. Leave blank for the branch tip.'}
                </small>
              </label>
            )}

            <div className="deploy-status">
              <span className={`status-dot ${deployTone}`} aria-hidden="true" />
              <span className="small" title={deployMessage}>
                {deployMessage}
              </span>
            </div>

            {deployDialog.check?.wouldRedeploy && (
              <>
                <div className="alert warning">
                  Branch “{deployDialog.branch}” at commit{' '}
                  {shortSha(deployDialog.check.deployCommit)} is already live.
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
                  deployDialog.check?.status !== 'ok' ||
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
