import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import DeployDialog from '../components/DeployDialog';
import StatusBadge from '../components/StatusBadge';
import { formatRelative } from '../format';
import type { Deployment, Site } from '../types';

export default function SitesPage() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [sites, setSites] = useState<Site[]>([]);
  const [latest, setLatest] = useState<Record<string, Deployment>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deployTarget, setDeployTarget] = useState<Site | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [siteResult, deploymentResult] = await Promise.all([
          api.listSites(),
          api.listDeployments(undefined, 200),
        ]);
        if (cancelled) return;

        setSites(siteResult.sites);
        const bySite: Record<string, Deployment> = {};
        for (const deployment of deploymentResult.deployments) {
          if (!bySite[deployment.siteId]) bySite[deployment.siteId] = deployment;
        }
        setLatest(bySite);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load sites.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function restore(site: Site) {
    if (!window.confirm(`Unarchive "${site.name}"?`)) return;
    await api.restoreSite(site.id);
    setSites((prev) => [...prev, site].sort((a, b) => a.name.localeCompare(b.name)));
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
          <Link className="btn primary" to="/sites/new">
            New site
          </Link>
        )}
      </header>

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="muted">Loading sites…</div>
      ) : sites.length === 0 ? (
        <div className="card empty-state">
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
        </div>
      ) : (
        <div className="card-grid">
          {sites.map((site) => {
            const last = latest[site.id];
            return (
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
                  {last ? (
                    <span className="small muted">
                      <StatusBadge status={last.status} />{' '}
                      {formatRelative(last.queuedAt)}
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
            );
          })}
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
