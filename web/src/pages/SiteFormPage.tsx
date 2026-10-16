import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import CheckboxList from '../components/CheckboxList';
import ErrorAlert from '../components/ErrorAlert';
import EnvVarsEditor from '../components/EnvVarsEditor';
import type {
  AuthType,
  ConnectionTest,
  DeployStrategy,
  SiteInput,
  UserAccount,
} from '../types';

const DEFAULTS: SiteInput = {
  name: '',
  repoUrl: '',
  branch: 'master',
  authType: 'ssh',
  accessToken: '',
  sshPrivateKey: '',
  installCommand: 'npm ci',
  buildCommand: 'npm run build',
  distDir: 'dist',
  targetDir: '',
  deployStrategy: 'releases',
  keepReleases: 5,
  envVars: {},
  enabled: true,
  draft: false,
};

/** Small refresh glyph for the "reload branches" button. */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={spinning ? 'spin' : undefined}
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

/** How a discovered script would be run with the repo's package manager. */
function runLabel(packageManager: string | null, scriptName: string): string {
  switch (packageManager) {
    case 'yarn':
      return `yarn ${scriptName}`;
    case 'pnpm':
      return `pnpm ${scriptName}`;
    case 'bun':
      return `bun run ${scriptName}`;
    default:
      return `npm run ${scriptName}`;
  }
}

export default function SiteFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [form, setForm] = useState<SiteInput>(DEFAULTS);
  const [loading, setLoading] = useState(mode === 'edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasAccessToken, setHasAccessToken] = useState(false);
  const [hasSshKey, setHasSshKey] = useState(false);
  const [sshPublicKeyPreview, setSshPublicKeyPreview] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [validating, setValidating] = useState(false);
  // Increments per validation run so a slow earlier response cannot overwrite a
  // newer one (e.g. switching branches quickly auto-validates several times).
  const validateRequest = useRef(0);
  const [validation, setValidation] = useState<ConnectionTest | null>(null);
  // Branches discovered by validation. Kept apart from `validation` because it
  // belongs to the repository, not the selected branch: picking a different
  // branch must not throw the list away.
  const [repoBranches, setRepoBranches] = useState<string[]>([]);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [deployers, setDeployers] = useState<UserAccount[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);

  // Deployers, for the access section. On edit, pre-tick the ones already
  // assigned to this site.
  useEffect(() => {
    let cancelled = false;
    api
      .listUsers()
      .then((result) => {
        if (cancelled) return;
        const list = result.users.filter((account) => account.role === 'deployer');
        setDeployers(list);
        if (mode === 'edit' && id) {
          setSelectedUserIds(
            list.filter((account) => account.siteIds.includes(id)).map((a) => a.id),
          );
        }
      })
      .catch(() => {
        // The form still works without the access list; leave it empty.
      });
    return () => {
      cancelled = true;
    };
  }, [id, mode]);

  useEffect(() => {
    if (mode !== 'edit' || !id) return;
    let cancelled = false;

    api
      .getSite(id)
      .then((site) => {
        if (cancelled) return;
        setForm({
          name: site.name,
          repoUrl: site.repoUrl,
          branch: site.branch,
          authType: site.authType,
          // Never populated from the API; blank means "keep the stored token".
          accessToken: '',
          installCommand: site.installCommand,
          buildCommand: site.buildCommand,
          distDir: site.distDir,
          targetDir: site.targetDir,
          deployStrategy: site.deployStrategy,
          keepReleases: site.keepReleases,
          envVars: site.envVars,
          enabled: site.enabled,
          draft: site.draft,
        });
        setHasAccessToken(site.hasAccessToken);
        setHasSshKey(site.sshPublicKey !== null);
        setSshPublicKeyPreview(site.sshPublicKey);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the site.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, mode]);

  function set<K extends keyof SiteInput>(key: K, value: SiteInput[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
    // Any change to the connection inputs makes a previous result stale.
    if (
      key === 'repoUrl' ||
      key === 'branch' ||
      key === 'authType' ||
      key === 'accessToken' ||
      key === 'sshPrivateKey'
    ) {
      setValidation(null);
      setValidateError(null);
    }
    // The branch list describes a repository, so only changes that could point
    // at a different one invalidate it — changing the branch itself does not.
    if (key === 'repoUrl' || key === 'authType' || key === 'accessToken' || key === 'sshPrivateKey') {
      setRepoBranches([]);
    }
  }

  const canValidate =
    form.repoUrl.trim().length > 0 &&
    form.branch.trim().length > 0 &&
    (form.authType === 'none' ||
      (form.authType === 'token' &&
        (Boolean(form.accessToken) || hasAccessToken)) ||
      (form.authType === 'ssh' && (hasSshKey || Boolean(form.sshPrivateKey))));

  async function generateSshKey() {
    setGeneratingKey(true);
    setError(null);
    try {
      const kp = await api.generateSshKeypair();
      set('sshPrivateKey', kp.privateKey);
      setSshPublicKeyPreview(kp.publicKey);
      setValidateError(null);
      setValidation(null);
      setRepoBranches([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate a key.');
    } finally {
      setGeneratingKey(false);
    }
  }

  async function validateConnection(branchOverride?: string) {
    const requestId = (validateRequest.current += 1);
    setValidating(true);
    setValidation(null);
    setValidateError(null);
    try {
      const result = await api.validateSite({
        siteId: id,
        repoUrl: form.repoUrl,
        branch: branchOverride ?? form.branch,
        authType: form.authType,
        accessToken: form.accessToken || undefined,
        sshPrivateKey: form.sshPrivateKey || undefined,
      });
      if (requestId !== validateRequest.current) return;
      setValidation(result);
      // Populates the branch dropdown; an empty list falls back to free text.
      setRepoBranches(result.branches);
      // The backend resolves a common default when the requested branch is missing,
      // so a single round-trip covers both the availability check and "main"/"master"
      // fallback (rather than a re-run after picking).
      if (
        result.resolvedBranch &&
        result.resolvedBranch !== (branchOverride ?? form.branch).trim()
      ) {
        setForm((previous) => ({
          ...previous,
          branch: result.resolvedBranch as string,
        }));
      }
    } catch (err) {
      if (requestId !== validateRequest.current) return;
      setValidation(null);
      // Keep the last known branch list: a failed check (e.g. a transient
      // network error while auto-validating) should not take the dropdown away.
      setValidateError(
        err instanceof Error ? err.message : 'Could not validate the connection.',
      );
    } finally {
      if (requestId === validateRequest.current) setValidating(false);
    }
  }

  /**
   * Re-checks the connection after the branch is picked from the dropdown.
   * Only the dropdown triggers this — the free-text fallback does not, so
   * typing a branch name never fires a request per keystroke.
   */
  function onBranchPicked(branch: string) {
    set('branch', branch);
    if (canValidate) void validateConnection(branch);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = { ...form, sshPrivateKey: form.sshPrivateKey?.trim() || undefined };
      const saved =
        mode === 'create'
          ? await api.createSite(payload)
          : await api.updateSite(id as string, payload);
      // A new site has no id until now, so user access is applied after the save.
      await api.setSiteAccess(saved.id, selectedUserIds);
      navigate(`/sites/${saved.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the site.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="page muted">Loading…</div>;

  const pkg = validation?.packageJson ?? null;
  const showAside = validating || validation !== null || validateError !== null;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{mode === 'create' ? 'New site' : 'Edit site'}</h1>
          <p className="muted">
            {mode === 'create'
              ? 'Connect a repository and choose where its build output lands.'
              : `Editing ${form.name}`}
          </p>
        </div>
        <div className="header-actions">
          <label className="toggle" title="Drafts need only a name; finish details later">
            <input
              type="checkbox"
              className="toggle-input"
              checked={Boolean(form.draft)}
              onChange={(event) => set('draft', event.target.checked)}
            />
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
            <span className="toggle-label">Draft</span>
          </label>
          <Link className="btn ghost" to={id ? `/sites/${id}` : '/'}>
            Cancel
          </Link>
        </div>
      </header>

      {error && <ErrorAlert message={error} />}

      <div className={`site-form-layout${showAside ? ' with-aside' : ''}`}>
        <form onSubmit={submit} className="stack">
          <section className="card">
            <h2>Repository</h2>

            <label className="field">
              <span>Site name</span>
              <input
                className="input"
                value={form.name}
                required
                placeholder="Marketing site"
                onChange={(event) => set('name', event.target.value)}
              />
            </label>

            <label className="field">
              <span>Repository URL</span>
              <input
                className="input mono"
                value={form.repoUrl}
                required={!form.draft}
                placeholder={
                  form.authType === 'token'
                    ? 'https://github.com/owner/repo.git'
                    : 'git@github.com:owner/repo.git'
                }
                onChange={(event) => set('repoUrl', event.target.value)}
              />
              <small className="hint">
                {form.authType === 'ssh'
                  ? 'Use the SSH URL — the deploy key handles authentication.'
                  : form.authType === 'token'
                    ? 'Use the HTTPS URL — the token is sent as an Authorization header.'
                    : 'Use an https:// URL for public repositories.'}
              </small>
            </label>

            <div className="field">
              <span>Authentication</span>
              <div className="field-row">
                <select
                  className="input"
                  value={form.authType}
                  onChange={(event) => set('authType', event.target.value as AuthType)}
                >
                  <option value="ssh">SSH deploy key</option>
                  <option value="token">Personal access token (HTTPS)</option>
                  <option value="none">None (public repository over HTTPS)</option>
                </select>
                <button
                  className="btn"
                  type="button"
                  disabled={validating || !canValidate}
                  onClick={() => void validateConnection()}
                >
                  {validating ? 'Validating…' : 'Validate connection'}
                </button>
                {validation && (
                  <span
                    className={`badge ${
                      validation.ok
                        ? validation.branchFound
                          ? 'badge-success'
                          : 'badge-queued'
                        : 'badge-failed'
                    }`}
                  >
                    {validation.ok
                      ? validation.branchFound
                        ? 'Reachable'
                        : 'Branch missing'
                      : 'Unreachable'}
                  </span>
                )}
              </div>
              <small className="hint">
                {form.authType === 'ssh' ? (
                  <>
                    A dedicated keypair is generated when you save the site. Copy the
                    public key shown on the site page and add it on GitHub as a
                    {' '}read-only deploy key (Settings → Deploy keys).{' '}
                    <a
                      href="https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#deploy-keys"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      How to add a deploy key →
                    </a>
                  </>
                ) : form.authType === 'token' ? (
                  <>
                    A read-only token with access to the repository. Stored
                    encrypted.{' '}
                    <a
                      href="https://github.com/settings/tokens/new?scopes=repo&description=Lift-Off%20deploy"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Generate a classic token →
                    </a>{' '}
                    (or{' '}
                    <a
                      href="https://github.com/settings/personal-access-tokens/new"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      a fine-grained token
                    </a>
                    .)
                  </>
                ) : 'Only works for public repositories.'}
              </small>
              <small className="hint">
                {!canValidate
                  ? form.authType === 'ssh'
                    ? 'Save the site first to generate its deploy key, then validate.'
                    : form.authType === 'token'
                      ? 'Enter an access token, then validate.'
                      : 'Enter a repository URL, then validate.'
                  : 'Checks the connection and lists the scripts in package.json.'}
              </small>
            </div>

            {form.authType === 'token' && (
              <label className="field">
                <span>Access token</span>
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  value={form.accessToken ?? ''}
                  required={form.authType === 'token' && !form.draft && !hasAccessToken}
                  placeholder={
                    hasAccessToken
                      ? '•••••••• (leave blank to keep the current token)'
                      : 'github_pat_…'
                  }
                  onChange={(event) => set('accessToken', event.target.value)}
                />
                <small className="hint">
                  {hasAccessToken
                    ? 'A token is already stored. Type a new one only to replace it.'
                    : 'Read-only access to the repository is enough.'}
                </small>
              </label>
            )}

            {form.authType === 'ssh' && (
              <label className="field">
                <span>SSH private key (optional)</span>
                <textarea
                  className="input mono key-box"
                  autoComplete="off"
                  spellCheck={false}
                  rows={5}
                  value={form.sshPrivateKey ?? ''}
                  placeholder="Generate one below, or paste an existing key…"
                  onChange={(event) => {
                    set('sshPrivateKey', event.target.value);
                    if (event.target.value !== sshPublicKeyPreview) {
                      // Clear stale derived preview when typing manually.
                      setSshPublicKeyPreview(null);
                    }
                  }}
                />
                <small className="hint">
                  {hasSshKey && !form.sshPrivateKey
                    ? 'A keypair is already stored for this site. Paste one above to replace it, or leave blank to keep using it.'
                    : form.sshPrivateKey
                      ? 'This key will be saved and used for validation and deploy.'
                      : 'Paste an existing key, or generate a fresh keypair below to test without saving first.'}
                </small>

                {sshPublicKeyPreview && (
                  <>
                    <span className="hint-label">Public key (add this to GitHub → Settings → Deploy keys)</span>
                    <textarea
                      className="input mono key-box"
                      readOnly
                      rows={3}
                      value={sshPublicKeyPreview}
                    />
                  </>
                )}

                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    disabled={generatingKey || validating}
                    onClick={() => void generateSshKey()}
                  >
                    {generatingKey ? 'Generating…' : sshPublicKeyPreview ? 'Regenerate keypair' : 'Generate keypair'}
                  </button>
                  <span className="muted small">
                    Generates a keypair in the browser’s request and shows its
                    public half so you can test before saving.
                  </span>
                </div>
              </label>
            )}

            <label className="field">
              <span>Branch</span>
              <div className="field-row">
                {repoBranches.length > 0 ? (
                  <select
                    className="input mono"
                    value={form.branch}
                    required={!form.draft}
                    onChange={(event) => onBranchPicked(event.target.value)}
                  >
                    {!repoBranches.includes(form.branch) && (
                      <option value={form.branch}>
                        {form.branch || 'Select a branch…'}
                      </option>
                    )}
                    {repoBranches.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input mono"
                    value={form.branch}
                    required={!form.draft}
                    placeholder="master"
                    onChange={(event) => set('branch', event.target.value)}
                  />
                )}
                <button
                  className="btn icon"
                  type="button"
                  title="Reload the branch list from the remote"
                  aria-label="Reload the branch list"
                  disabled={validating || !canValidate}
                  onClick={() => void validateConnection()}
                >
                  <RefreshIcon spinning={validating} />
                </button>
              </div>
              <small className="hint">
                {repoBranches.length > 0
                  ? `${repoBranches.length} branch${
                      repoBranches.length === 1 ? '' : 'es'
                    } found on the remote. Picking one re-checks the connection.`
                  : 'Validate the connection to load this repository\u2019s branches.'}
              </small>
            </label>
          </section>

          <section className="card">
            <h2>Build</h2>

            <label className="field">
              <span>Install command</span>
              <input
                className="input mono"
                value={form.installCommand}
                placeholder="npm ci"
                onChange={(event) => set('installCommand', event.target.value)}
              />
              <small className="hint">Runs first. Leave empty to skip.</small>
            </label>

            <label className="field">
              <span>Build command</span>
              <input
                className="input mono"
                value={form.buildCommand}
                placeholder="npm run build"
                onChange={(event) => set('buildCommand', event.target.value)}
              />
            </label>

            <label className="field">
              <span>Output directory</span>
              <input
                className="input mono"
                value={form.distDir}
                required={!form.draft}
                placeholder="dist"
                onChange={(event) => set('distDir', event.target.value)}
              />
              <small className="hint">
                Path inside the repository that the build command produces.
              </small>
            </label>

            <div className="field">
              <span>Environment variables</span>
              <EnvVarsEditor
                value={form.envVars}
                onChange={(next) => set('envVars', next)}
              />
              <small className="hint">
                Passed to the install and build commands. Not stored in the repo.
              </small>
            </div>
          </section>

          <section className="card">
            <h2>Deployment</h2>

            <label className="field">
              <span>Target directory</span>
              <input
                className="input mono"
                value={form.targetDir}
                required={!form.draft}
                placeholder="/var/www/my-site"
                onChange={(event) => set('targetDir', event.target.value)}
              />
              <small className="hint">Absolute path on this server.</small>
            </label>

            <label className="field">
              <span>Strategy</span>
              <select
                className="input"
                value={form.deployStrategy}
                onChange={(event) =>
                  set('deployStrategy', event.target.value as DeployStrategy)
                }
              >
                <option value="releases">
                  Atomic releases + current symlink (rollback supported)
                </option>
                <option value="direct">Direct copy (overwrites target)</option>
              </select>
              <small className="hint">
                {form.deployStrategy === 'releases'
                  ? `Each build gets its own folder under <target>/releases, then a "current" symlink is swapped atomically. Point your web server at <target>/current.`
                  : 'The target directory is emptied and replaced on every deploy. Brief downtime, no rollback.'}
              </small>
            </label>

            {form.deployStrategy === 'releases' && (
              <label className="field">
                <span>Releases to keep</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={50}
                  value={form.keepReleases}
                  onChange={(event) =>
                    set('keepReleases', Number(event.target.value) || 1)
                  }
                />
                <small className="hint">Older releases beyond this count are pruned.</small>
              </label>
            )}

            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => set('enabled', event.target.checked)}
              />
              Enabled (disables the deploy button when unchecked)
            </label>
          </section>

          <section className="card">
            <h2>User access</h2>
            <p className="muted small">
              Tick the Deployers who may deploy and roll back this site. Admins
              always have access to every site, and a site with nobody ticked stays
              admin-only.
              {mode === 'create' && ' Access is applied when you create the site.'}
            </p>
            <CheckboxList
              options={deployers.map((account) => ({
                id: account.id,
                label: account.username,
              }))}
              selected={selectedUserIds}
              onChange={setSelectedUserIds}
              filterPlaceholder="Filter users…"
              emptyMessage="No Deployer accounts yet. Add one under Users, then assign it here."
            />
          </section>

          <div className="form-actions">
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : mode === 'create' ? 'Create site' : 'Save changes'}
            </button>
          </div>
        </form>

        {showAside && (
          <aside className="site-form-aside">
            <section className="card">
              <h2>Connection</h2>

              {validating && <p className="muted small">Checking the repository…</p>}

              <ErrorAlert message={validateError} />

              {validation && (
                <div
                  className={`alert ${
                    validation.ok
                      ? validation.branchFound
                        ? 'success'
                        : 'warning'
                      : 'error'
                  }`}
                >
                  {validation.message}
                </div>
              )}

              {validation && validation.ok && !pkg && (
                <p className="muted small">
                  No <code>package.json</code> at the root of this branch
                  (non-Node project, or the build lives in a subfolder). Set the
                  install/build commands yourself.
                </p>
              )}

              {pkg && (
                <>
                  <p className="muted small">
                    {pkg.name ? `${pkg.name} · ` : ''}
                    {pkg.scripts.length > 0
                      ? 'Click a script to use it as the build command.'
                      : 'package.json has no scripts.'}
                  </p>
                  {pkg.scripts.length > 0 && (
                    <ul className="command-list">
                      {pkg.scripts.map((script) => {
                        const label = runLabel(pkg.packageManager, script.name);
                        return (
                          <li key={script.name}>
                            <button
                              className="command-item"
                              type="button"
                              onClick={() => set('buildCommand', label)}
                            >
                              <span className="command-run mono">{label}</span>
                              <span className="muted small ellipsis">
                                {script.command}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}
