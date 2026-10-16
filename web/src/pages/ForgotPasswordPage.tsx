import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import ErrorAlert from '../components/ErrorAlert';

export default function ForgotPasswordPage() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.forgotPassword(username);
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
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

        {message ? (
          <>
            <h2>Check your email</h2>
            <p className="muted">{message}</p>
            <Link className="btn ghost block" to="/login">
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <h2>Reset your password</h2>
            <p className="muted">
              Enter your username. If it has an email address on file, we will send a
              reset link there.
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

            {error && <ErrorAlert message={error} />}

            <button className="btn primary block" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>

            <p className="small center">
              <Link className="link" to="/login">
                Back to sign in
              </Link>
            </p>
          </>
        )}
      </form>
    </div>
  );
}
