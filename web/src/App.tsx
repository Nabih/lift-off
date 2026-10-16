import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Layout from './components/Layout';
import DeploymentPage from './pages/DeploymentPage';
import DeploymentsPage from './pages/DeploymentsPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import LoginPage from './pages/LoginPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import SettingsPage from './pages/SettingsPage';
import SiteDetailPage from './pages/SiteDetailPage';
import SiteFormPage from './pages/SiteFormPage';
import SitesPage from './pages/SitesPage';
import UsersPage from './pages/UsersPage';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { status } = useAuth();
  if (status === 'loading') {
    return <div className="boot-screen">Loading…</div>;
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace />;
  }
  return children;
}

/** Site configuration and user management are admin-only. */
function RequireAdmin({ children }: { children: JSX.Element }) {
  const { status, isAdmin } = useAuth();
  if (status === 'loading') {
    return <div className="boot-screen">Loading…</div>;
  }
  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<SitesPage />} />
          <Route path="/deployments" element={<DeploymentsPage />} />
          <Route path="/deployments/:id" element={<DeploymentPage />} />
          <Route path="/settings" element={<SettingsPage />} />

          <Route
            path="/sites/new"
            element={
              <RequireAdmin>
                <SiteFormPage mode="create" />
              </RequireAdmin>
            }
          />
          <Route
            path="/sites/:id/edit"
            element={
              <RequireAdmin>
                <SiteFormPage mode="edit" />
              </RequireAdmin>
            }
          />
          <Route path="/sites/:id" element={<SiteDetailPage />} />

          <Route
            path="/users"
            element={
              <RequireAdmin>
                <UsersPage />
              </RequireAdmin>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
