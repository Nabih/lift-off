import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import ErrorAlert from './ErrorAlert';
import { shortSha } from '../format';
import type { DeployCheck, RemoteCommit, Site } from '../types';

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

/**
 * Confirms a deploy and lets the user choose exactly what to put live: a branch,
 * and optionally a specific commit. Used from both the site page and the sites
 * list so the two entry points behave identically.
 *
 * The component owns its own state and validation; the parent only supplies the
 * site and the callbacks for closing and for a queued deployment.
 */
export default function DeployDialog({
  site,
  onClose,
  onDeployed,
}: {
  site: Site;
  onClose: () => void;
  /** Called with the new deployment id once the deploy has been queued. */
  onDeployed: (deploymentId: string) => void;
}) {
  const [state, setState] = useState<DeployDialogState>(() => ({
    branch: site.branch,
    commitEnabled: false,
    commit: '',
    commits: [],
    commitsLoading: false,
    check: null,
    checkError: null,
    checking: true,
    force: false,
  }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Monotonic id so a slow check cannot overwrite a newer one. */
  const checkRequest = useRef(0);

  const {
    branch,
    commitEnabled,
    commit,
    commits,
    commitsLoading,
    check,
    checkError,
    checking,
    force,
  } = state;

  /**
   * Validates a branch (and optional commit) against the remote. Slow responses
   * are dropped so a stale result cannot overwrite a newer one.
   */
  async function runCheck(targetBranch: string, targetCommit: string) {
    const requestId = (checkRequest.current += 1);
    setState((current) => ({ ...current, checking: true }));
    try {
      const result = await api.deployCheck(site.id, {
        branch: targetBranch,
        commit: targetCommit.trim() || undefined,
      });
      if (requestId !== checkRequest.current) return;
      setState((current) => ({
        ...current,
        check: result,
        checking: false,
        checkError: null,
      }));
    } catch (err) {
      if (requestId !== checkRequest.current) return;
      setState((current) => ({
        ...current,
        check: null,
        checking: false,
        checkError: err instanceof Error ? err.message : 'Check failed.',
      }));
    }
  }

  // Re-check whenever the target changes. Debounced so typing a commit id does
  // not fire a request per keystroke. Deliberately keyed on the branch/commit
  // only — updating `check`/`checking` must not re-trigger it.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      void runCheck(branch, commitEnabled ? commit : '');
    }, 300);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, commit, commitEnabled]);

  /** Loads the recent commits for the picker. */
  async function loadCommits(targetBranch: string) {
    setState((current) => ({ ...current, commitsLoading: true }));
    try {
      const { commits: loaded } = await api.listCommits(site.id, targetBranch);
      setState((current) =>
        current.branch === targetBranch
          ? { ...current, commits: loaded, commitsLoading: false }
          : current,
      );
    } catch {
      setState((current) => ({ ...current, commits: [], commitsLoading: false }));
    }
  }

  function pickBranch(next: string) {
    if (next === branch) return;
    // A commit belongs to a branch, so switching branch clears it.
    setState((current) => ({ ...current, branch: next, commit: '', force: false }));
    if (commitEnabled) void loadCommits(next);
  }

  function toggleCommit(enabled: boolean) {
    setState((current) => ({
      ...current,
      commitEnabled: enabled,
      commit: enabled ? current.commit : '',
      force: false,
    }));
    if (enabled) void loadCommits(branch);
  }

  function setCommit(value: string) {
    setState((current) => ({ ...current, commit: value, force: false }));
  }

  async function submit() {
    const commitValue = commitEnabled ? commit.trim() : '';
    setSubmitting(true);
    setError(null);
    try {
      const { deploymentId } = await api.deploySite(site.id, {
        branch,
        commit: commitValue || undefined,
        force,
      });
      onDeployed(deploymentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the deployment.');
      // A 409 means the server disagreed with our check (e.g. a race). Re-check
      // so the dialog reflects the current state.
      if (err instanceof ApiError && err.status === 409) {
        void runCheck(branch, commitValue);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Status icon tone: green when the branch/commit check passes, red when it
  // fails or the repo is unreachable, grey while idle or checking.
  const tone: 'idle' | 'ok' | 'error' = checking
    ? 'idle'
    : check?.status === 'ok'
      ? 'ok'
      : check || checkError
        ? 'error'
        : 'idle';
  const message = checking
    ? 'Checking…'
    : (check?.message ?? checkError ?? 'Not checked yet.');
  const canDeploy =
    check?.status === 'ok' &&
    !checking &&
    !submitting &&
    (!check?.wouldRedeploy || force);

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={() => {
        if (!submitting) onClose();
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
            value={branch}
            onChange={(event) => pickBranch(event.target.value)}
          >
            {!check?.branches.includes(branch) && (
              <option value={branch}>{branch}</option>
            )}
            {(check?.branches ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={commitEnabled}
            onChange={(event) => toggleCommit(event.target.checked)}
          />
          Commit
        </label>

        {commitEnabled && (
          <label className="field">
            <span>Commit</span>
            <input
              className="input mono"
              list="deploy-commit-options"
              value={commit}
              autoComplete="off"
              placeholder="Branch tip (leave blank) or a commit id"
              onChange={(event) => setCommit(event.target.value)}
            />
            <datalist id="deploy-commit-options">
              {commits.map((entry) => (
                <option key={entry.sha} value={entry.sha}>
                  {entry.shortSha} · {entry.subject}
                </option>
              ))}
            </datalist>
            <small className="hint">
              {commitsLoading
                ? 'Loading recent commits…'
                : commits.length > 0
                  ? `Last ${commits.length} commit${
                      commits.length === 1 ? '' : 's'
                    } on ${branch}. Pick one or type your own id.`
                  : 'Type a commit id. Leave blank for the branch tip.'}
            </small>
          </label>
        )}

        <div className="deploy-status">
          <span className={`status-dot ${tone}`} aria-hidden="true" />
          <span className="small" title={message}>
            {message}
          </span>
        </div>

        {check?.wouldRedeploy && (
          <>
            <div className="alert warning">
              Branch “{branch}” at commit {shortSha(check.deployCommit)} is already
              live.
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={force}
                onChange={(event) => {
                  const { checked } = event.target;
                  setState((current) => ({ ...current, force: checked }));
                }}
              />
              Force deploy (re-deploy the live branch and commit)
            </label>
          </>
        )}

        {error && <ErrorAlert message={error} />}

        <div className="form-actions">
          <button
            className="btn ghost"
            type="button"
            disabled={submitting}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!canDeploy}
            onClick={() => void submit()}
          >
            {submitting ? 'Starting…' : check?.wouldRedeploy ? 'Force deploy' : 'Deploy'}
          </button>
        </div>
      </div>
    </div>
  );
}
