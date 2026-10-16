import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'nav-link active' : 'nav-link';

export default function Layout() {
  const { logout, user, isAdmin } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">L</span>
          <span className="brand-name">Lift-Off</span>
        </div>

        <nav className="nav">
          <NavLink to="/" end className={linkClass}>
            Sites
          </NavLink>
          <NavLink to="/deployments" className={linkClass}>
            Deployments
          </NavLink>
          {isAdmin && (
            <NavLink to="/users" className={linkClass}>
              Users
            </NavLink>
          )}
          <NavLink to="/settings" className={linkClass}>
            Settings
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          {user && (
            <div className="current-user">
              <span className="current-user-name" title={user.username}>
                {user.username}
              </span>
              <span
                className={`badge ${user.role === 'admin' ? 'badge-running' : 'muted'}`}
              >
                {user.role}
              </span>
            </div>
          )}
          <button
            type="button"
            className="btn ghost block"
            onClick={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
