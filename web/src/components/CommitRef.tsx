import { shortSha } from '../format';
import { branchUrl, commitUrl, githubBase } from '../github';
import type { Deployment } from '../types';

interface Props {
  deployment: Deployment;
  /** How much of the commit subject to show; the tables use less than the header. */
  messageLength?: number;
}

/**
 * Commit sha and branch for a deployment, linked to GitHub when the remote is a
 * GitHub URL. The branch links to the tree *at that commit*, so it shows what
 * was actually deployed rather than the branch's current tip.
 *
 * Rollback and re-deployment both get a pill next to the branch: they qualify
 * that exact branch + commit, so they belong in this cluster rather than in the
 * status/site column, where a wide label stretched the whole column.
 */
export default function CommitRef({ deployment, messageLength = 48 }: Props) {
  const base = githubBase(deployment.repoUrl);
  const sha = deployment.commitSha;
  const commit = commitUrl(base, sha);
  const branch = branchUrl(base, deployment.branch, sha);

  return (
    <span className="commit-ref">
      {sha ? (
        commit ? (
          <a className="link mono" href={commit} target="_blank" rel="noreferrer">
            {shortSha(sha)}
          </a>
        ) : (
          <span className="mono">{shortSha(sha)}</span>
        )
      ) : (
        <span className="mono">—</span>
      )}

      {deployment.branch &&
        (branch ? (
          <a
            className="branch-ref mono"
            href={branch}
            target="_blank"
            rel="noreferrer"
            title={`${deployment.branch} at this commit`}
          >
            {deployment.branch}
          </a>
        ) : (
          <span className="branch-ref mono">{deployment.branch}</span>
        ))}

      {deployment.kind === 'rollback' && (
        <span
          className="rollback-ref"
          title="Rollback — this switched the live release back to an earlier one"
        >
          ↩ rollback
        </span>
      )}

      {deployment.redeploy && (
        <span
          className="redeploy-ref"
          title="Re-deployment — this branch and commit were already live"
        >
          ↻ re-deploy
        </span>
      )}

      {deployment.commitMessage && (
        <span className="muted">
          {deployment.commitMessage.slice(0, messageLength)}
        </span>
      )}
    </span>
  );
}
