import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import CommitRef from '../components/CommitRef';
import ErrorAlert from '../components/ErrorAlert';
import StatusBadge from '../components/StatusBadge';
import { formatDateTime, formatDuration, formatRelative } from '../format';
import type { Deployment } from '../types';

const PER_PAGE = 10;

/**
 * Returns the value after it has stopped changing for `delay` ms. Typing in the
 * search box updates the URL only once the user pauses, so we fire one request
 * instead of one per keystroke.
 */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export default function DeploymentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const siteId = searchParams.get('site') ?? undefined;

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const search = searchParams.get('search') ?? '';
  // Keep a local copy so typing stays responsive; the URL (and the request)
  // only follow once typing pauses.
  const [searchInput, setSearchInput] = useState(search);
  const debouncedSearch = useDebounced(searchInput, 200);
  const user = searchParams.get('user') ?? '';
  const type = (searchParams.get('type') ?? '') as
    | ''
    | 'regular'
    | 'rollback'
    | 'redeploy';
  const orderBy = (searchParams.get('orderBy') ?? 'time') as
    | 'site'
    | 'user'
    | 'time';
  const order = (searchParams.get('order') ?? 'desc') as 'asc' | 'desc';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  /** Any filter change resets paging; `keepPage` is used by the pager itself. */
  const setParam = useCallback(
    (key: string, value: string, keepPage = false) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      if (!keepPage) next.delete('page');
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // The debounced value is the ONLY writer of ?search=. Using the functional
  // updater means this effect does not depend on the searchParams object, which
  // is a new instance on every render.
  useEffect(() => {
    setSearchParams(
      (previous) => {
        // Nothing to do when the search already matches — this is the case on
        // mount, so a ?page= from a shared link is not thrown away.
        if ((previous.get('search') ?? '') === debouncedSearch) return previous;
        const next = new URLSearchParams(previous);
        if (debouncedSearch) next.set('search', debouncedSearch);
        else next.delete('search');
        next.delete('page'); // a new search always starts from the first page
        return next;
      },
      { replace: true },
    );
  }, [debouncedSearch, setSearchParams]);

  const load = useCallback(async () => {
    try {
      const result = await api.listDeployments({
        siteId,
        search: search || undefined,
        user: user || undefined,
        type: type || undefined,
        orderBy,
        order,
        page,
        limit: PER_PAGE,
      });
      setDeployments(result.deployments);
      setUsers(result.users);
      setTotal(result.total);
      setPages(result.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load deployments.');
    }
  }, [siteId, search, user, type, orderBy, order, page]);

  // Fetch whenever the user changes a filter, the page, or the scoped site.
  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  // Poll only while a deployment on this page is still in flight, so a running
  // build flips to its final status. Once every row has finished we stop making
  // requests altogether until something actually changes.
  const hasActiveDeployments = deployments.some(
    (deployment) =>
      deployment.status === 'queued' || deployment.status === 'running',
  );

  useEffect(() => {
    if (!hasActiveDeployments) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [hasActiveDeployments, load]);

  // Adopt a search that arrived from somewhere else (a shared link, the back
  // button). `pushedSearch` is the last value we wrote, so our own writes do not
  // bounce back and reset what the user is typing.
  const pushedSearch = useRef(search);
  useEffect(() => {
    pushedSearch.current = debouncedSearch;
  }, [debouncedSearch]);

  useEffect(() => {
    if (search === pushedSearch.current) return;
    pushedSearch.current = search;
    setSearchInput(search);
  }, [search]);

  const from = total === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Deployments</h1>
          <p className="muted">
            {siteId ? 'Deployments for this site.' : 'Every build and rollback.'}
          </p>
        </div>
        {siteId && (
          <Link className="btn ghost" to="/deployments">
            Show all sites
          </Link>
        )}
      </header>

      {error && <ErrorAlert message={error} />}

      <section className="card">
        <div className="filters">
          <label className="field">
            <span>Site name</span>
            <input
              className="input"
              value={searchInput}
              placeholder="Search sites…"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>

          <label className="field">
            <span>User</span>
            <select
              className="input"
              value={user}
              onChange={(event) => setParam('user', event.target.value)}
            >
              <option value="">All users</option>
              {users.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Type</span>
            <select
              className="input"
              value={type}
              onChange={(event) => setParam('type', event.target.value)}
            >
              <option value="">All types</option>
              <option value="regular">Regular</option>
              <option value="rollback">Rollback</option>
              <option value="redeploy">Redeployed</option>
            </select>
          </label>

          <label className="field">
            <span>Order by</span>
            <select
              className="input"
              value={orderBy}
              onChange={(event) => setParam('orderBy', event.target.value)}
            >
              <option value="time">Deployment time</option>
              <option value="site">Site</option>
              <option value="user">User</option>
            </select>
          </label>

          <label className="field">
            <span>Order</span>
            <select
              className="input"
              value={order}
              onChange={(event) => setParam('order', event.target.value)}
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </label>
        </div>
      </section>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : deployments.length === 0 ? (
        <div className="card empty-state">
          <p className="muted">No deployments match these filters.</p>
        </div>
      ) : (
        <>
          <section className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Site</th>
                  <th>Commit</th>
                  <th>User</th>
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
                    <td className="small mono">{deployment.triggeredBy ?? '—'}</td>
                    <td
                      className="small"
                      title={formatDateTime(deployment.queuedAt)}
                    >
                      {formatRelative(deployment.queuedAt)}
                    </td>
                    <td className="small">
                      {formatDuration(deployment.durationMs)}
                    </td>
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

          <div className="pager">
            <span className="muted small">
              Showing {from}–{to} of {total}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn small"
              disabled={page <= 1}
              onClick={() => setParam('page', String(page - 1), true)}
            >
              Previous
            </button>
            <span className="muted small">
              Page {page} of {pages}
            </span>
            <button
              type="button"
              className="btn small"
              disabled={page >= pages}
              onClick={() => setParam('page', String(page + 1), true)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}