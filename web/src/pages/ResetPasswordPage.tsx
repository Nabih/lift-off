import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import ErrorAlert from '../components/ErrorAlert';

const REASON_MESSAGES: Record<string, string> = {
  invalid: 'That reset link is not valid.',
  expired: 'That reset link has expired. Request a new one.',
  used: 'That reset link has already been used.',
};

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [checking, setChecking] = useState(true);
  const [valid, setValid] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setReason('invalid');
      setChecking(false);
      return;
    }
    let cancelled = false;
    api
      .checkResetToken(token)
      .then((result) => {
        if (cancelled) return;
        setValid(result.valid);
        if (!result.valid) setReason(result.reason ?? 'invalid');
      })
      .catch(() => {
        if (!cancelled) setReason('invalid');
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }

    setBusy(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="card login-card">
        <div className="brand large">
          <span className="brand-mark">L</span>
          <span className="brand-name">Lift-Off</span>
        </div>

        {done ? (
          <>
            <h2>Password updated</h2>
            <p className="muted">You can now sign in with your new password.</p>
            <Link className="btn primary block" to="/login">
              Sign in
            </Link>
          </>
        ) : checking ? (
          <p className="muted">Checking your link…</p>
        ) : !valid ? (
          <>
            <h2>Link unusable</h2>
            <p className="muted">{REASON_MESSAGES[reason ?? 'invalid']}</p>
            <Link className="btn ghost block" to="/forgot-password">
              Request a new link
            </Link>
          </>
        ) : (
          <form onSubmit={submit} className="stack">
            <h2>Choose a new password</h2>

            <label className="field">
              <span>New password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>

            <label className="field">
              <span>Confirm new password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
              />
            </label>

            {error && <ErrorAlert message={error} />}

            <button className="btn primary block" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
