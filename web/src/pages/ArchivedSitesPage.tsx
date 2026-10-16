import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import ErrorAlert from '../components/ErrorAlert';
import type { Site } from '../types';

export default function ArchivedSitesPage() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listSites({ deleted: true });
      setSites(result.sites);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load archived sites.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="page">
        <ErrorAlert message="Administrator access is required." />
        <Link className="btn ghost" to="/">
          Back to sites
        </Link>
      </div>
    );
  }

  async function unarchive(site: Site) {
    if (!window.confirm(`Restore "${site.name}"? It must not clash with a live site's name or target directory.`)) return;
    setWorking(site.id);
    setError(null);
    try {
      await api.restoreSite(site.id);
      setSites((prev) => prev.filter((s) => s.id !== site.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore the site.');
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Archived sites</h1>
          <p className="muted">
            Only administrators can view and restore these. A site is kept here
            instead of being deleted outright, so nothing is lost.
          </p>
        </div>
        <Link className="btn ghost" to="/">
          Back to sites
        </Link>
      </header>

      {error && <ErrorAlert message={error} />}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : sites.length === 0 ? (
        <div className="card empty-state">
          <h2>No archived sites</h2>
          <p className="muted">There is nothing to restore right now.</p>
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Branch</th>
                <th>Target</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr key={site.id}>
                  <td>
                    <Link className="site-name" to={`/sites/${site.id}`}>
                      {site.name}
                    </Link>
                    <span className="badge draft">archived</span>
                  </td>
                  <td className="mono small">{site.branch}</td>
                  <td className="mono small ellipsis" title={site.targetDir}>
                    {site.targetDir}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn primary small"
                      disabled={working === site.id}
                      onClick={() => void unarchive(site)}
                    >
                      {working === site.id ? 'Restoring…' : 'Restore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
