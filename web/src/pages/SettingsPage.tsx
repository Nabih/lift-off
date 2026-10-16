import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { MailSettings } from '../types';

export default function SettingsPage() {
  const { usingGeneratedPassword, refresh, user, isAdmin } = useAuth();
  const [health, setHealth] = useState<{ queueDepth: number; uptimeSeconds: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system/health', { credentials: 'include' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page narrow">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">Your account, email delivery, and server status.</p>
        </div>
      </header>

      {user?.isOwner && usingGeneratedPassword && (
        <div className="alert warning">
          You are still using the auto-generated owner password. Set your own below.
        </div>
      )}

      <section className="card">
        <h2>Account</h2>
        <dl className="meta-list">
          <div>
            <dt>Username</dt>
            <dd className="mono">{user?.username}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>
              {user?.role}
              {user?.isOwner ? ' (owner)' : ''}
            </dd>
          </div>
        </dl>
      </section>

      <RecoveryEmailCard onSaved={refresh} />
      <ChangePasswordCard onSaved={refresh} />
      {isAdmin && <MailSettingsCard />}

      <section className="card">
        <h2>Server</h2>
        <dl className="meta-list">
          <div>
            <dt>Background jobs</dt>
            <dd>{health ? health.queueDepth : '—'}</dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>{health ? `${Math.floor(health.uptimeSeconds / 60)} min` : '—'}</dd>
          </div>
        </dl>
        <p className="muted small">
          Builds run directly on this host. Build scripts from a repository execute
          with the same privileges as the Lift-Off service, so only connect
          repositories you trust.
        </p>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function RecoveryEmailCard({ onSaved }: { onSaved: () => Promise<void> }) {
  const { user } = useAuth();
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await api.setEmail(password, email);
      setPassword('');
      setMessage('Recovery email saved.');
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the email address.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Recovery email</h2>
      <p className="muted small">
        Usernames are used to sign in; this address is only used to send a password
        reset link. It is never shown to anyone else.
      </p>
      <form onSubmit={submit} className="stack">
        <div className="grid-2">
          <label className="field">
            <span>Email address</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              placeholder="you@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Confirm with your password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </div>
        <small className="hint">Leave the address blank and save to remove it.</small>

        {message && <div className="alert success">{message}</div>}
        {error && <div className="alert error">{error}</div>}

        <div className="form-actions">
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save email'}
          </button>
        </div>
      </form>
    </section>
  );
}

function ChangePasswordCard({ onSaved }: { onSaved: () => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }

    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setMessage('Password updated.');
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Change password</h2>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Current password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </label>

        <div className="grid-2">
          <label className="field">
            <span>New password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          </label>
        </div>

        {message && <div className="alert success">{message}</div>}
        {error && <div className="alert error">{error}</div>}

        <div className="form-actions">
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Update password'}
          </button>
        </div>
      </form>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

const EMPTY_MAIL: MailSettings = {
  publicUrl: '',
  host: '',
  port: 587,
  secure: false,
  user: '',
  from: '',
  hasPassword: false,
  configured: false,
};

function MailSettingsCard() {
  const [form, setForm] = useState<MailSettings>(EMPTY_MAIL);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMailSettings()
      .then((settings) => {
        if (!cancelled) setForm(settings);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load email settings.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof MailSettings>(key: K, value: MailSettings[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const saved = await api.saveMailSettings({
        publicUrl: form.publicUrl,
        host: form.host,
        port: form.port,
        secure: form.secure,
        user: form.user,
        from: form.from,
        ...(password ? { pass: password } : {}),
      });
      setForm(saved);
      setPassword('');
      setMessage('Email settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save email settings.');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setMessage(null);
    setError(null);
    try {
      const result = await api.sendTestEmail();
      setMessage(`Test email sent to ${result.to}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the test email.');
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <section className="card muted">Loading email settings…</section>;

  return (
    <section className="card">
      <h2>Email delivery (password resets)</h2>
      <p className="muted small">
        Used to send password reset links. Without this, users can only have their
        password set for them from the Users page.
      </p>

      {!form.configured && (
        <div className="alert warning">
          Password reset emails are disabled until the public URL, SMTP host, and from
          address are filled in.
        </div>
      )}

      <form onSubmit={save} className="stack">
        <label className="field">
          <span>Public URL</span>
          <input
            className="input mono"
            value={form.publicUrl}
            placeholder="https://liftoff.example.com"
            onChange={(event) => set('publicUrl', event.target.value)}
          />
          <small className="hint">
            The address people use to reach this instance. Reset links are built from it.
          </small>
        </label>

        <div className="grid-2">
          <label className="field">
            <span>SMTP host</span>
            <input
              className="input mono"
              value={form.host}
              placeholder="smtp.example.com"
              onChange={(event) => set('host', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Port</span>
            <input
              className="input"
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(event) => set('port', Number(event.target.value) || 587)}
            />
          </label>
        </div>

        <div className="grid-2">
          <label className="field">
            <span>SMTP username</span>
            <input
              className="input mono"
              autoComplete="off"
              value={form.user}
              placeholder="apikey"
              onChange={(event) => set('user', event.target.value)}
            />
          </label>
          <label className="field">
            <span>SMTP password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              placeholder={form.hasPassword ? '•••••••• (stored)' : ''}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </div>

        <label className="field">
          <span>From address</span>
          <input
            className="input"
            value={form.from}
            placeholder="Lift-Off <noreply@example.com>"
            onChange={(event) => set('from', event.target.value)}
          />
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.secure}
            onChange={(event) => set('secure', event.target.checked)}
          />
          Use implicit TLS (port 465). Leave off for STARTTLS on 587.
        </label>

        {message && <div className="alert success">{message}</div>}
        {error && <div className="alert error">{error}</div>}

        <div className="form-actions">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save email settings'}
          </button>
          <button
            className="btn ghost"
            type="button"
            disabled={testing || !form.configured}
            onClick={sendTest}
          >
            {testing ? 'Sending…' : 'Send test email'}
          </button>
        </div>
      </form>
    </section>
  );
}
