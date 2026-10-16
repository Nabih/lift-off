import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import DeployDialog from '../components/DeployDialog';
import ErrorAlert from '../components/ErrorAlert';
import StatusBadge from '../components/StatusBadge';
import { formatRelative } from '../format';
import type { ListedSite, Site } from '../types';
import { useDebounced } from '../useDebounced';

/** Cards per page. Six fills two rows of the three-column grid. */
const PER_PAGE = 6;

export default function SitesPage() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [sites, setSites] = useState<ListedSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deployTarget, setDeployTarget] = useState<Site | null>(null);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);

  const search = searchParams.get('search') ?? '';
  // Keep a local copy so typing stays responsive; the URL (and the request)
  // only follow once typing pauses.
  const [searchInput, setSearchInput] = useState(search);
  const [debouncedSearch, applySearchNow] = useDebounced(searchInput, 200);
  const filter = (searchParams.get('filter') ?? 'all') as
    | 'all'
    | 'never-deployed'
    | 'draft'
    | 'disabled';
  const orderBy = (searchParams.get('orderBy') ?? 'name') as
    | 'name'
    | 'last-deploy'
    | 'created';
  const order = (searchParams.get('order') ?? 'asc') as 'asc' | 'desc';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  const filtering =
    Boolean(search) || filter !== 'all' || orderBy !== 'name' || order !== 'asc';

  /** Any filter change resets paging; `keepPage` is used by the pager itself. */
  const setParam = useCallback(
    (key: string, value: string, keepPage = false) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value) next.set(key, value);
          else next.delete(key);
          if (!keepPage) next.delete('page');
          return next;
        },
        { replace: !keepPage },
      );
    },
    [setSearchParams],
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
      const result = await api.listSites({
        search: search || undefined,
        filter,
        orderBy,
        order,
        page,
        limit: PER_PAGE,
      });
      setSites(result.sites);
      setTotal(result.total);
      setPages(result.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load sites.');
    }
  }, [search, filter, orderBy, order, page]);

  // Fetch whenever the user changes a filter, the order, or the page.
  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  // Poll only while a deployment on this page is still in flight, so a running
  // build flips to its final status on the card. Once every card has finished we
  // stop making requests altogether until something actually changes.
  const hasActiveDeployments = sites.some(
    (site) =>
      site.latest?.status === 'queued' || site.latest?.status === 'running',
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

  // The server clamps an out-of-range page, so follow it rather than stranding
  // the user on an empty grid with a pager that can only go backwards.
  useEffect(() => {
    if (!loading && page > pages) setParam('page', String(pages), true);
  }, [loading, page, pages, setParam]);

  const from = total === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);

  function clearFilters() {
    // Apply the empty search immediately as well as clearing the URL: otherwise
    // the debounced value still holds the old term and pushes ?search= back.
    applySearchNow('');
    setSearchInput('');
    setSearchParams(new URLSearchParams(), { replace: true });
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Sites</h1>
          <p className="muted">
            Each site points at a GitHub repository and a directory to ship to.
          </p>
        </div>
        {isAdmin && (
          <div className="header-actions">
            <Link className="btn ghost" to="/sites/archived">
              Archived sites
            </Link>
            <Link className="btn primary" to="/sites/new">
              New site
            </Link>
          </div>
        )}
      </header>

      {error && <ErrorAlert message={error} />}

      <section className="card">
        <div className="filters">
          <label className="field">
            <span>Site name or repo</span>
            <input
              className="input"
              value={searchInput}
              placeholder="Search sites…"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>

          <label className="field">
            <span>Show</span>
            <select
              className="input"
              value={filter}
              onChange={(event) => setParam('filter', event.target.value)}
            >
              <option value="all">All sites</option>
              <option value="never-deployed">Never deployed</option>
              <option value="draft">Drafts</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>

          <label className="field">
            <span>Order by</span>
            <select
              className="input"
              value={orderBy}
              onChange={(event) => setParam('orderBy', event.target.value)}
            >
              <option value="name">Name</option>
              <option value="last-deploy">Last deployment</option>
              <option value="created">Date added</option>
            </select>
          </label>

          <label className="field">
            <span>Order</span>
            <select
              className="input"
              value={order}
              onChange={(event) => setParam('order', event.target.value)}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>
        </div>
      </section>

      {loading ? (
        <div className="muted">Loading sites…</div>
      ) : sites.length === 0 ? (
        <div className="card empty-state">
          {filtering ? (
            <>
              <h2>No sites match</h2>
              <p className="muted">
                Nothing here matches the current search and filters.
              </p>
              <button
                type="button"
                className="btn ghost"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            </>
          ) : (
            <>
              <h2>No sites yet</h2>
              <p className="muted">
                {isAdmin
                  ? 'Create your first site to connect a repository and configure where its build output is deployed.'
                  : 'No sites are assigned to your account yet. Ask an administrator to grant you access.'}
              </p>
              {isAdmin && (
                <Link className="btn primary" to="/sites/new">
                  Create a site
                </Link>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="card-grid">
          {sites.map((site) => (
            <article className="card site-card" key={site.id}>
              <div className="site-card-head">
                <Link to={`/sites/${site.id}`} className="site-name">
                  {site.name}
                </Link>
                {!site.enabled && <span className="badge muted">disabled</span>}
                {site.draft && <span className="badge draft">draft</span>}
              </div>

              <div className="mono small muted ellipsis" title={site.repoUrl}>
                {site.repoUrl}
              </div>

              <dl className="meta-list small">
                <div>
                  <dt>Branch</dt>
                  <dd className="mono">{site.branch}</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd className="mono ellipsis" title={site.targetDir}>
                    {site.targetDir}
                  </dd>
                </div>
                <div>
                  <dt>Strategy</dt>
                  <dd>{site.deployStrategy}</dd>
                </div>
              </dl>

              <div className="site-card-foot">
                {site.latest ? (
                  <span className="small muted">
                    <StatusBadge status={site.latest.status} />{' '}
                    {formatRelative(site.latest.queuedAt)}
                  </span>
                ) : (
                  <span className="small muted">Never deployed</span>
                )}
                <span className="spacer" />
                <button
                  type="button"
                  className="btn primary small"
                  disabled={!site.enabled || site.draft}
                  onClick={() => setDeployTarget(site)}
                >
                  Deploy
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {pages > 1 && (
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
      )}

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