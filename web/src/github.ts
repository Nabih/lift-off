/**
 * Turns a git remote URL into a browsable GitHub base, or null when the host is
 * not GitHub (in which case the UI falls back to plain, unlinked text).
 *
 * Handles the two forms git remotes actually use:
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git  (and ssh://git@github.com/owner/repo.git)
 */
export function githubBase(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;

  let host: string;
  let repoPath: string;

  const scp = repoUrl.match(/^[^\s@/]+@([^\s:/]+):(.+)$/);
  if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(repoUrl);
    } catch {
      return null;
    }
    host = url.hostname;
    repoPath = url.pathname.replace(/^\/+/, '');
  }

  if (!/^(www\.)?github\.com$/i.test(host)) return null;

  repoPath = repoPath.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!repoPath) return null;

  return `https://github.com/${repoPath}`;
}

/** Web URL for a commit; GitHub resolves an abbreviated sha too. */
export function commitUrl(
  base: string | null,
  sha: string | null | undefined,
): string | null {
  return base && sha ? `${base}/commit/${sha}` : null;
}

/**
 * Web URL for a branch. When a commit is known the branch is opened at that
 * commit (`/tree/<sha>`), so the link shows the tree that was deployed rather
 * than whatever the branch points at now.
 */
export function branchUrl(
  base: string | null,
  branch: string | null | undefined,
  sha: string | null | undefined,
): string | null {
  if (!base) return null;
  if (sha) return `${base}/tree/${sha}`;
  return branch ? `${base}/tree/${branch}` : null;
}
