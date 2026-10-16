import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

/** Shown only on a fresh install: creates the first (owner) account. */
export default function SetupPage() {
  const { refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.bootstrap({
        username,
        password,
        email: email.trim() || undefined,
      });
      await refresh();
      window.location.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand large">
          <span className="brand-mark">L</span>
          <span className="brand-name">Lift-Off</span>
        </div>
        <p className="muted">
          Welcome. This is a first-run install — create the owner account to get
          started. You only see this once.
        </p>

        <label className="field">
          <span>Username</span>
          <input
            className="input"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="admin"
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 10 characters"
          />
        </label>

        <label className="field">
          <span>Confirm password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="••••••••"
          />
        </label>

        <label className="field">
          <span>Email (optional, for password resets)</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </label>

        {error && <div className="alert error">{error}</div>}

        <button className="btn primary block" type="submit" disabled={busy}>
          {busy ? 'Creating account…' : 'Create owner account'}
        </button>

        <p className="muted small">
          No password is stored anywhere but the database (hashed). Automated installs
          can bootstrap with <code>npm run seed:admin</code>.
        </p>
      </form>
    </div>
  );
}
