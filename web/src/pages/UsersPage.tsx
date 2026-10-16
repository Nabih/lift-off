import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import CheckboxList from '../components/CheckboxList';
import ErrorAlert from '../components/ErrorAlert';
import { formatDateTime, formatRelative } from '../format';
import type { Role, Site, UserAccount } from '../types';

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const [userResult, siteResult] = await Promise.all([
      api.listUsers(),
      api.listSites(),
    ]);
    setUsers(userResult.users);
    setSites(siteResult.sites);
  }

  useEffect(() => {
    let cancelled = false;
    load()
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load users.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function act(id: string, action: () => Promise<unknown>, message: string) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      setNotice(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  }

  const siteNames = (ids: string[]) =>
    ids
      .map((id) => sites.find((site) => site.id === id)?.name)
      .filter((name): name is string => Boolean(name));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Users</h1>
          <p className="muted">
            Admins manage sites and users. Deployers can deploy and roll back only
            the sites assigned to them.
          </p>
        </div>
        {!creating && !editing && (
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              setCreating(true);
              setNotice(null);
            }}
          >
            Add user
          </button>
        )}
      </header>

      {error && <ErrorAlert message={error} />}
      {notice && <div className="alert success">{notice}</div>}

      {(creating || editing) && (
        <UserForm
          existing={editing}
          sites={sites}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async (message) => {
            setCreating(false);
            setEditing(null);
            await load();
            setNotice(message);
          }}
        />
      )}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : (
        <section className="card">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Site access</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((account) => {
                const isSelf = account.id === currentUser?.id;
                const assigned = siteNames(account.siteIds);
                return (
                  <tr key={account.id}>
                    <td>
                      <span className="mono">{account.username}</span>
                      {account.isOwner && <span className="badge muted">owner</span>}
                      {isSelf && <span className="badge muted">you</span>}
                      {account.disabled && (
                        <span className="badge failed">disabled</span>
                      )}
                      {account.email ? (
                        <div className="muted small">{account.email}</div>
                      ) : (
                        <div className="muted small">no account email</div>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          account.role === 'admin' ? 'badge-running' : 'muted'
                        }`}
                      >
                        {account.role}
                      </span>
                    </td>
                    <td className="small">
                      {account.role === 'admin' ? (
                        <span className="muted">All sites</span>
                      ) : assigned.length === 0 ? (
                        <span className="muted">None assigned</span>
                      ) : (
                        <span title={assigned.join(', ')}>
                          {assigned.length === 1
                            ? assigned[0]
                            : `${assigned.length} sites`}
                        </span>
                      )}
                    </td>
                    <td
                      className="small"
                      title={account.lastLoginAt ? formatDateTime(account.lastLoginAt) : ''}
                    >
                      {account.lastLoginAt ? formatRelative(account.lastLoginAt) : 'Never'}
                    </td>
                    <td className="row-actions">
                      <button
                        className="btn ghost small"
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => {
                          setEditing(account);
                          setCreating(false);
                          setNotice(null);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="btn ghost small"
                        type="button"
                        disabled={busyId !== null || isSelf}
                        onClick={() =>
                          void act(
                            account.id,
                            () => api.updateUser(account.id, { disabled: !account.disabled }),
                            account.disabled
                              ? `Enabled ${account.username}.`
                              : `Disabled ${account.username}.`,
                          )
                        }
                      >
                        {account.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button
                        className="btn danger small"
                        type="button"
                        disabled={busyId !== null || account.isOwner || isSelf}
                        title={
                          account.isOwner
                            ? 'The owner account cannot be deleted.'
                            : isSelf
                              ? 'You cannot delete your own account.'
                              : undefined
                        }
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Delete "${account.username}"? This cannot be undone.`,
                            )
                          ) {
                            return;
                          }
                          void act(
                            account.id,
                            () => api.deleteUser(account.id),
                            `Deleted ${account.username}.`,
                          );
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface FormProps {
  existing: UserAccount | null;
  sites: Site[];
  onCancel: () => void;
  onSaved: (message: string) => void | Promise<void>;
}

function UserForm({ existing, sites, onCancel, onSaved }: FormProps) {
  const [username, setUsername] = useState(existing?.username ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(existing?.role ?? 'deployer');
  const [siteIds, setSiteIds] = useState<string[]>(existing?.siteIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOwner = existing?.isOwner ?? false;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api.updateUser(existing.id, {
          username,
          email,
          role,
          siteIds,
          // Omit the password entirely when left blank so it is not reset.
          ...(password ? { password } : {}),
        });
        await onSaved(`Saved ${username}.`);
      } else {
        await api.createUser({ username, email, password, role, siteIds });
        await onSaved(`Created ${username}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the user.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{existing ? `Edit ${existing.username}` : 'New user'}</h2>

      {error && <ErrorAlert message={error} />}

      <div className="grid-2">
        <label className="field">
          <span>Username</span>
          <input
            className="input mono"
            value={username}
            required
            autoComplete="off"
            onChange={(event) => setUsername(event.target.value)}
          />
          <small className="hint">3–32 characters: letters, numbers, . - _</small>
        </label>

        <label className="field">
          <span>{existing ? 'New password (optional)' : 'Password'}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            required={!existing}
            placeholder={existing ? 'Leave blank to keep current' : ''}
            onChange={(event) => setPassword(event.target.value)}
          />
          <small className="hint">
            {existing
              ? 'Filling this in resets the password.'
              : 'At least 8 characters.'}
          </small>
        </label>
      </div>

      <label className="field">
        <span>Account email (optional)</span>
        <input
          className="input"
          type="email"
          autoComplete="off"
          value={email}
          placeholder="teammate@example.com"
          onChange={(event) => setEmail(event.target.value)}
        />
        <small className="hint">
          Only used to send password reset links. Blank means no self-service reset.
        </small>
      </label>

      <label className="field">
        <span>Role</span>
        <select
          className="input"
          value={role}
          disabled={isOwner}
          onChange={(event) => setRole(event.target.value as Role)}
        >
          <option value="deployer">
            Deployer — deploy and roll back assigned sites
          </option>
          <option value="admin">Admin — full control, including users</option>
        </select>
        <small className="hint">
          {isOwner
            ? 'The owner account must remain an admin.'
            : role === 'admin'
              ? 'Admins can reach every site and manage users.'
              : 'Deployers only see and operate the sites you assign below.'}
        </small>
      </label>

      {role === 'deployer' && (
        <div className="field">
          <span>Assigned sites</span>
          <CheckboxList
            options={sites.map((site) => ({ id: site.id, label: site.name }))}
            selected={siteIds}
            onChange={setSiteIds}
            filterPlaceholder="Filter sites…"
            emptyMessage="No sites exist yet. Create a site first, then assign it here."
          />
        </div>
      )}

      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Create user'}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
