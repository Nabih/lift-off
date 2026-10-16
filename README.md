# Lift-Off

A small, self-hosted deployment system for a VPS. You configure a **site** in a
React UI — repository, build command, output folder, destination directory — and
Lift-Off clones the repo, runs the build, and ships the result.

- Repositories over an **SSH deploy key**, a **personal access token**, or
  anonymously for public repos.
- **Validate a connection while configuring a site**, pick the branch from a
  dropdown of the repository's branches, and pick a build command from the
  scripts in the repository's `package.json`.
- **Admin** and **Deployer** roles, with deployers limited to the sites they are
  assigned.
- Atomic releases with a `current` symlink and one-click rollback, or a simple
  direct copy.
- **Re-deploy awareness**: a deploy that would reproduce the live branch and
  commit must be confirmed and forced, and commits and branches link to GitHub.
- **Password resets by email**, with SMTP configured in the UI.

```
GitHub repo ──► git fetch/reset ──► install ──► build ──► dist/ ──► target dir
                                                                      │
                                        releases/<stamp>-<sha>  + atomic `current` symlink
```

Everything runs in one Node process: the Express API, the build runner, and the
built React UI.

---

## Requirements

| Dependency | Why |
| --- | --- |
| **Node.js ≥ 22.5** (24 recommended) | The server uses the built-in `node:sqlite` module, so there is **no native build step**. |
| **git** | Cloning and fetching repositories. |
| **ssh-keygen** | Generating a deploy key per site (OpenSSH). |
| npm / pnpm / yarn | Only if your projects use them — the install command is configurable. |

No database server, no Docker, no compilation.

---

## Quick start (development)

```bash
git clone https://github.com/Nabih/lift-off.git
cd lift-off
npm install
npm run dev
```

- UI: <http://localhost:5173> (Vite dev server, proxies `/api` to the backend)
- API: <http://localhost:4000>

On first boot the server prints a generated admin password:

```
  ┌──────────────────────────────────────────────────────────┐
  │  Lift-Off generated an admin password (change it soon):    │
  │      a1b2c3d4e5f6a7b8                                      │
  └──────────────────────────────────────────────────────────┘
```

Set `LIFTOFF_ADMIN_PASSWORD` to skip that and choose your own.

---

## Production on a VPS

```bash
# 1. Install dependencies and build both workspaces
npm install
npm run build            # builds web/dist and server/dist

# 2. Configure
cp .env.example .env     # then edit: set LIFTOFF_ADMIN_PASSWORD, LIFTOFF_SECRET_KEY

# 3. Run under pm2
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

In production the Express server serves `web/dist` itself, so a single process
handles the UI and the API on port 4000.

### Example nginx front-end

Lift-Off is an admin tool — put it behind TLS and, ideally, an IP allowlist.

```nginx
server {
    listen 443 ssl;
    server_name liftoff.example.com;

    # allow 203.0.113.10; deny all;   # optional allowlist

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # required for live build logs (Server-Sent Events)
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

Set `LIFTOFF_COOKIE_SECURE=true` once you are serving over HTTPS.

### Deployed sites with nginx

With the **releases** strategy, point the site's server block at the `current`
symlink so deploys switch over atomically with no downtime:

```nginx
server {
    listen 80;
    server_name app.example.com;
    root /var/www/my-site/current;   # not the target dir itself
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}
```

---

## Connecting a repository

A site uses one of three authentication modes. Secrets are always encrypted at
rest with AES-256-GCM before they touch the database.

### SSH deploy key (recommended)

Lift-Off generates a **per-site SSH keypair**; the private half is encrypted at
rest.

1. In Lift-Off: **New site** → set the name, choose **SSH deploy key**, and enter
   the repository's **SSH** URL, e.g. `git@github.com:owner/repo.git`.
2. Save. Lift-Off generates a keypair and shows the **public key**.
3. On GitHub: **repository → Settings → Deploy keys → Add deploy key**, paste
   the key, leave *Allow write access* **off**.
4. Back in Lift-Off, click **Test connection** to confirm access.
5. Click **Deploy now**.

`StrictHostKeyChecking` is set to `accept-new` with a Lift-Off-owned
`known_hosts` file, so the host is trusted on first contact and pinned after.

### Personal access token (HTTPS)

Choose **Personal access token (HTTPS)** and use the `https://` clone URL, e.g.
`https://github.com/owner/repo.git`, with a GitHub token that can read the
repository (a fine-grained token with *Contents: read*, or a classic token with
`repo` scope for private repositories).

The token is stored encrypted and is **never sent back to the browser** — the
site page only reports whether one is saved. To replace it, open **Edit**, type a
new token, and save; leaving the field blank keeps the current one.

Git receives the token through `GIT_CONFIG_*` environment variables as an HTTP
`Authorization` header, so it never appears in the process list (`ps`) or in the
cloned repository's `.git/config`.

### None (public repositories)

Choose **None (public repository over HTTPS)** with an `https://` URL. No
credentials are sent. Only use this for repositories that are already public.

In all three modes git is run non-interactively
(`GIT_TERMINAL_PROMPT=0` and `ssh -o BatchMode=yes`), so a bad credential fails
fast instead of hanging on a prompt.

### Validate the connection before saving

The site form has a **Validate connection** button next to the authentication
fields. It checks the repository and, when it can reach the branch, reads the
branch's `package.json` and lists its scripts in a panel on the right. Clicking a
script fills the **Build command** box, so you can configure a repo without
guessing what its scripts are called.

- It works for token and public repositories before the site is saved.
- For **SSH**, the deploy key only exists once the site is saved, so the button is
  disabled until then: save the site, add the public key on GitHub, and then use
  **Edit → Validate connection** (or **Test connection** on the site page).
- A **Reachable** badge means the remote answered and the branch exists. A
  *Branch missing* badge still means the connection works but the branch name is
  wrong; the panel lists the branches that do exist.
- A successful check also turns the **Branch** box into a **dropdown** of the
  repository's branches. If the check returns no branches (unreachable repository,
  or a host that does not list them), the box stays a free-text field so you can
  still type a branch name.
- A **refresh icon** next to the Branch box re-runs the check on demand, so you can
  pick up a branch that was just pushed without re-validating by hand. It spins and
  disables itself while the check is in flight.
- Picking a different branch from the dropdown **re-runs the check automatically**,
  so the scripts and the connection badge follow the branch you selected. Typing
  in the free-text field does not auto-check (that would fire a request per
  keystroke); use the button.
- Scripts are shown from the branch's `package.json` (e.g. `npm run build`,
  adjusted for a declared package manager such as pnpm or yarn), but nothing from
  the repository is executed by the check.

---

## Site settings

| Setting | Meaning |
| --- | --- |
| **Repository URL** | SSH (`git@github.com:owner/repo.git`) for deploy keys, or HTTPS for tokens and public repos. |
| **Branch** | Defaults to `master`. Becomes a dropdown of the remote's branches after a successful **Validate connection**; stays free text otherwise. |
| **Authentication** | Per-site SSH deploy key, a personal access token, or none for public repos. |
| **Access token** | Only for token auth. Stored encrypted and never shown again; leave blank to keep the saved one. |
| **Install command** | Runs before the build, e.g. `npm ci`. Leave empty to skip. |
| **Build command** | e.g. `npm run build`. |
| **Output directory** | Path inside the repo the build produces, e.g. `dist`. Must stay inside the repo. |
| **Environment variables** | Injected into the install/build commands only. Not written to disk. |
| **Target directory** | Absolute path on the server where output is deployed. |
| **Strategy** | `releases` or `direct` (see below). |
| **Releases to keep** | How many old releases to retain before pruning. |
| **User access** | Which Deployers may operate the site. Admins always have access; a site with nobody ticked is admin-only. |

### Deploy strategies

**Atomic releases + `current` symlink** (default)

```
/var/www/my-site/
├── releases/
│   ├── 20261015-232608-412-2b64cc5/
│   └── 20261015-232459-907-6318e72/
└── current -> releases/20261015-232608-412-2b64cc5
```

Each build goes to its own timestamped folder, then the `current` symlink is
swapped with a single atomic `rename(2)`. No downtime, and **Roll back** re-points
`current` at the previous release. Old releases are pruned automatically, never
the live one.

The release name is `<timestamp>-<short sha>`, and recency is inferred by sorting
those names, so the timestamp is recorded to the millisecond and a clashing name
is suffixed. That keeps rollback and pruning correct even when two deploys
finish within the same second.

**Direct copy** — the target directory is emptied and replaced on every deploy.
Simpler, but there is a brief window with no files and no rollback.

### Deploying, and re-deploying

**Deploy now** always asks for confirmation first, in a dialog that lets you choose
exactly what to put live:

- **Branch** — a dropdown of the remote's branches, defaulting to the site's
  configured branch. You can deploy a different branch without editing the site.
- **Commit** — off by default, meaning "the tip of that branch". Tick it to reveal a
  picker listing the branch's **last 10 commits with their messages**; it is a text
  field as well, so you can paste or type any commit id (full or abbreviated).
- **Status icon** — grey while idle or checking, **green** once the connection
  succeeds and both the branch and the commit are valid, and **red** when the
  connection fails or the branch/commit does not exist. A short message explains why.
- **Force deploy** appears when the chosen branch *and* commit are already serving.

A deploy is blocked by default when it would change nothing. If the branch **and**
the commit that would be deployed are the ones already serving, the dialog offers a
**Force deploy** tick box and the deploy is refused (HTTP `409`) until it is ticked.
This stops an accidental "deploy" from stacking an identical release on top of the
one that is already live. The server performs the same check, so the guard holds for
the API too, not just the UI.

Each deployment records the **branch** and the **head commit** it built. In the
deployment listings the short commit links to that commit on GitHub, and the branch
links to the tree **at that commit** — what was deployed, not the branch's current
tip. A forced deploy of what was already live gets a small **↻ re-deploy** pill next
to the branch, both in the deployment lists and on the **Releases** card, so the
label sits with the branch and commit it actually describes.

Rollbacks record the commit they reverted to, so "what is live" stays accurate after
a roll back instead of pointing at the release that was superseded.

---

## Users and roles

There are two roles. The first account, created on boot, is additionally the
**owner**.

| | Admin | Deployer |
| --- | --- | --- |
| View sites, deployments, logs | every site | assigned sites only |
| Deploy and roll back | every site | assigned sites only |
| Create, edit, delete sites | yes | no |
| Regenerate deploy keys | yes | no |
| Manage users | yes | no |
| Set recovery emails | any account | own only |
| Configure email / SMTP | yes | no |
| Read build env var **values** | yes | no — names only |
| Validate a repository, list its `package.json` scripts | yes | no |

- **Owner** — the account created on first boot. It is an admin that cannot be
  deleted, disabled, or demoted, and only the owner can modify it. This is what
  stops a mistake locking you out of your own system.
- **Admin** — full control, including adding, editing, and removing users.
- **Deployer** — can operate the sites assigned to it, and nothing else. This is
  the role to hand to a teammate or a CI job: they can ship, but cannot repoint a
  target directory, change a repository URL, or read build secrets.

Assignments can be set from either side, and both lists have a filter box so you
can find the right user or site quickly:

- **By user** — **Users → Edit → Assigned sites**.
- **By site** — **Edit site → User access** (or when creating a site; the
  assignment is applied when the site is saved).

Admins ignore the assignment list and reach every site. A site with nobody
assigned is admin-only, and a user can hold as many sites as you tick. Changes
take effect on the next request — disabling or deleting an account ends its
session immediately, and removing a site assignment revokes access to that site
right away.

Deleting a user or a site cleans up the corresponding assignments automatically.

Sessions also end when the account's password changes: a password change or
reset bumps an internal session version, so any session opened before it stops
working. Changing your *own* password keeps you signed in on the browser you are
using and signs out your other sessions.

---

## Passwords and email delivery

People sign in with a **username**, not an email address. An email address is
optional and has exactly one purpose: receiving a password-reset link.

### Email addresses

- Each account can have one recovery address. An admin sets it from **Users**;
  anyone can set their own from **Settings → Recovery email** (confirmed with
  their password).
- Addresses must be unique and are stored lower case.
- Nobody can see anyone else's address except an admin.

### Resetting a password

On the sign-in page, **Forgot your password?** asks for a username only. The
server then:

1. answers immediately with a fixed message — *"If that account exists and has an
   email address on file, a reset link is on its way"* — whether or not the
   account exists, and in the same amount of time, so responses cannot be used to
   discover who has an account;
2. looks the account up in the background and, if it has an address, emails a
   single-use link.

Reset links expire after **60 minutes**, work **once**, and are invalidated
whenever a newer link is requested. Only a hash of the token is stored, so a
database leak cannot be replayed. Requests are rate-limited (per IP and per
username). Completing a reset signs out every existing session for that account.

Lift-Off must be able to send mail for any of this to work. An admin configures
SMTP under **Settings → Email delivery (password resets)**:

| Field | Notes |
| --- | --- |
| **Public URL** | The address people use to reach Lift-Off, e.g. `https://liftoff.example.com`. Reset links are built from it. Required. |
| **SMTP host / Port** | Your provider's host and port (`587` for STARTTLS, `465` for implicit TLS). |
| **SMTP username / password** | The password is encrypted at rest and never sent back to the browser. |
| **From address** | What recipients see; e.g. `Lift-Off <noreply@example.com>`. |
| **Use implicit TLS (port 465)** | Tick for `465`; leave off for STARTTLS on `587`. |

**Send test email** sends a message using the saved settings so you can confirm
them before relying on them.

If email is not configured, everyone still has a fallback: an admin can set a new
password for any account from **Users → Edit → New password**.

---

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port. |
| `LIFTOFF_DATA_DIR` | `./data` | Database, deploy keys, cloned repos. |
| `LIFTOFF_SECRET_KEY` | generated file | 32 bytes (64 hex chars or base64) for encrypting secrets at rest. |
| `LIFTOFF_ADMIN_PASSWORD` | generated | Password for the owner account on first boot. |
| `LIFTOFF_ADMIN_USERNAME` | `admin` | Username for the owner account on first boot. |
| `LIFTOFF_COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS. |
| `LIFTOFF_MAX_CONCURRENT_BUILDS` | `1` | Parallel builds. |
| `LIFTOFF_WEB_DIST` | `./web/dist` | Location of the built UI. |
| `NODE_ENV` | — | `production` enables serving the built UI. |

The data directory layout:

```
data/
├── liftoff.db      # sites, users, deployments, logs, settings
├── secret.key      # master encryption key (0600)
├── keys/           # materialised deploy keys + known_hosts
└── workspaces/     # one persistent git clone per site
```

---

## Security model

**Builds run directly on the host, as the user running Lift-Off.** A repository's
install/build scripts are arbitrary code with that user's privileges. Only
connect repositories you trust. For untrusted code, run Lift-Off itself inside a
container or a dedicated unprivileged user account.

Other notes:

- SSH private keys and personal access tokens are encrypted with AES-256-GCM; the
  master key lives in `data/secret.key` (0600) or `LIFTOFF_SECRET_KEY`.
- Personal access tokens are passed to git through environment variables as an
  HTTP header, so they never appear in `ps` output or in `.git/config`, and they
  are never returned to the browser after being saved.
- Passwords are stored as scrypt hashes; sessions are signed HTTP-only cookies.
  Sign-in responses are identical for an unknown username and a wrong password,
  and unknown usernames are verified against a decoy hash so timing cannot be
  used to enumerate accounts.
- Changing or resetting a password bumps a per-account session version, so every
  existing session for that account is invalidated at that moment.
- Password-reset requests always return the same message and take the same time
  regardless of whether the account exists, and are rate-limited per IP and per
  username. Reset tokens are random, single-use, expire after 60 minutes, and are
  stored only as a hash.
- Roles are re-checked from the database on every request, so disabling,
  deleting, or demoting an account takes effect immediately.
- Deployers never receive build env var values, and site/route access is
  enforced on the server — hiding a button in the UI is a convenience, not the
  control.
- Target directories are validated: the filesystem root, Lift-Off's own data
  directory, and the project directory are all rejected, and the output
  directory cannot escape the repository.
- Git never prompts: `GIT_TERMINAL_PROMPT=0` and ssh `BatchMode=yes`.
- There is no public sign-up; accounts exist only because an admin created
  them, and the UI is intended to sit behind TLS and an IP allowlist.

---

## API reference

All `/api/sites` and `/api/deployments` routes require the session cookie.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Sign in with username and password. |
| `POST` | `/api/auth/logout` | Sign out. |
| `GET` | `/api/auth/me` | Current user and session. |
| `POST` | `/api/auth/password` | Change your own password. |
| `PATCH` | `/api/auth/email` | Set or clear your own recovery email (password-confirmed). |
| `POST` | `/api/auth/forgot-password` | Request a reset link. Always the same generic reply. |
| `GET` | `/api/auth/reset-password/:token` | Check whether a reset token is still usable. |
| `POST` | `/api/auth/reset-password` | Set a new password with a reset token. |
| `GET` | `/api/users` | List accounts (**admin**). |
| `POST` | `/api/users` | Create an account (**admin**). |
| `PATCH` | `/api/users/:id` | Role, password, email, assignments, disabled (**admin**). |
| `DELETE` | `/api/users/:id` | Delete an account (**admin**). |
| `GET` | `/api/settings/mail` | Read email settings (**admin**; password never returned). |
| `PUT` | `/api/settings/mail` | Save email settings (**admin**). |
| `POST` | `/api/settings/mail/test` | Send a test email (**admin**). |
| `GET` | `/api/system/health` | Liveness + queue depth (public). |
| `GET` | `/api/sites` | List sites. |
| `POST` | `/api/sites` | Create a site (generates a keypair for SSH auth). |
| `GET/PATCH/DELETE` | `/api/sites/:id` | Read, update, delete a site. |
| `POST` | `/api/sites/validate` | Check a repo config from the form and return its `package.json` scripts (**admin**). |
| `POST` | `/api/sites/:id/ssh-key` | Regenerate the deploy keypair. |
| `PUT` | `/api/sites/:id/access` | Replace which Deployers can reach a site (**admin**). |
| `POST` | `/api/sites/:id/test` | Verify repo access and branch. |
| `POST` | `/api/sites/:id/deploy` | Queue a build. Body `{ branch?, commit?, force? }`; refused with `409` for an unknown branch/commit or when the branch + commit are already live unless forced → `202 { deploymentId }`. |
| `GET` | `/api/sites/:id/deploy-check` | What a deploy would do for `?branch=&commit=`: remote reachability, whether the branch and commit exist, the commit that would be built, the branches, and whether it would be a re-deploy. |
| `GET` | `/api/sites/:id/commits` | The most recent commits on `?branch=` (default 10) with their messages, for the commit picker. |
| `POST` | `/api/sites/:id/rollback` | Roll `current` back one release. |
| `GET` | `/api/sites/:id/releases` | List releases and which is live. |
| `GET` | `/api/deployments` | Deployment history (`?siteId=&limit=`). |
| `GET` | `/api/deployments/:id` | One deployment. |
| `GET` | `/api/deployments/:id/logs` | Persisted log lines. |
| `GET` | `/api/deployments/:id/stream` | Live log stream (SSE). |

---

## Project structure

```
server/src/
  index.ts        Express app, route mounting, static UI, error handling
  auth.ts         Users, password hashing, sessions, requireAuth, session versioning
  guards.ts       requireAdmin, per-site access checks, HttpError, shared validation
  config.ts       Paths, ports, limits
  crypto.ts       AES-256-GCM + scrypt (no native deps)
  db.ts           node:sqlite schema, migrations, settings
  store.ts        All SQL queries
  git.ts          Clone/fetch/reset (or a pinned commit), SSH and token auth,
                  connection test, form-time validation + package.json discovery,
                  branch/commit listing and resolution
  ssh.ts          ssh-keygen keypair generation
  runner.ts       Build queue and deploy pipeline
  deploy.ts       Releases vs direct, atomic symlink, rollback, pruning
  log.ts          Log persistence + live fan-out
  mail.ts         SMTP transport built from UI settings, reset/test emails
  password-reset.ts  Single-use reset tokens (hashed, 60 min)
  ratelimit.ts    Small in-memory sliding-window limiter
  process.ts      Streaming command execution (with timeouts for network steps)
  routes/         auth, users, sites, deployments (incl. SSE), settings

web/src/
  App.tsx         Routes, auth guard, admin guard, public reset routes
  api.ts          Typed API client
  github.ts       Git remote URL → GitHub commit/branch links
  components/     Layout, LogViewer, StatusBadge, CopyButton, EnvVarsEditor,
                  CheckboxList (filtered multi-select for access assignment),
                  CommitRef (linked commit + branch for a deployment)
  pages/          Login, ForgotPassword, ResetPassword, Sites, SiteForm,
                  SiteDetail, Deployments, Deployment, Users, Settings
```

---

## Troubleshooting

**Locked out / lost the owner password** — if email is configured, use
**Forgot your password?** on the sign-in page. Otherwise stop the server, remove
the rows from the `users` table (or delete `data/liftoff.db` to start over), set
`LIFTOFF_ADMIN_PASSWORD`, and restart. A fresh owner account is created on the
next boot. An admin can also reset any other account's password from **Users**.

**"Your password changed. Please sign in again."** — you are signed in with a
session issued before a password change or reset on your account. This is
deliberate: every other session for that account is invalidated at the same
moment. Sign in again with the new password.

**"Administrator access is required"** — you are signed in as a Deployer. Site
configuration and user management need an admin account.

**A Deployer cannot see a site** — assign it under **Users → Edit → Assigned
sites**. Deployers only see what is assigned to them.

**"Permission denied (publickey)"** — the deploy key is not on the repository,
or you pasted the wrong half. Copy the *public* key from the site page into
GitHub's deploy keys.

**"Branch ... was not found on the remote"** — check the branch name; `master`
and `main` are different.

**Validate connection shows no scripts** — the repository was reachable but no
`package.json` was found at the root of the branch. Either the project keeps it
elsewhere, or the remote does not support shallow fetches (a repo served as plain
static files over "dumb" HTTP). Connection and branch checks still work; type the
build command yourself in that case.

**"Build output ... was not produced"** — the build command did not create the
configured output directory. Check the log for the real error; often a missing
`dist` because the build failed silently.

**Live logs do not appear** — a proxy in front of Lift-Off is buffering the
response. Set `proxy_buffering off;` (nginx) and keep the `X-Accel-Buffering: no`
header that Lift-Off sends.

**Deployments stuck on "Failed — Interrupted by a server restart"** — a build
was in flight when the process stopped; they are marked failed on the next boot
rather than left running. Deploy again.

**Reset emails never arrive** — check **Settings → Email delivery** and press
**Send test email**. Password reset only works once the public URL, SMTP host,
and from address are set. If the test succeeds, look in the recipient's spam
folder; Lift-Off always says the same thing whether or not the account exists, so
a missing email does not mean the account is missing.
