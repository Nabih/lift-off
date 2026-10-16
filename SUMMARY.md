# Lift-Off — working summary

Personal notes on what was built, why, and what's left. Not documentation —
`README.md` is the user-facing doc. This is the "what did I decide and why" file.

> **Maintenance rule: keep this file current.** Update it in the same change that
> alters behaviour or scope — not later. At minimum, each round of work must
> leave behind: a decisions entry (what was chosen **and why**), the affected
> files in the file map, and what was actually verified (with the evidence).
> Move anything finished out of section 9. If a gotcha bites, add it to section 8.
> A stale summary is worse than none, because it is trusted.

**Status:** feature-complete for the stated goal, builds and typechecks clean,
verified end to end. Not yet deployed to the VPS.

Rounds so far: (1) core deploy pipeline, (2) users/roles/owner, (3) PAT auth +
email password reset, (4) form-time repository validation + script discovery,
(5) renamed to **Lift-Off** and published publicly, (6) site-side access
assignment + filtered assignment lists, (7) branch dropdown from the validated
repository, (8) re-deploy detection, forced deploys, and GitHub links.

---

## 1. The goal

A React-based deployment system for a VPS:

- UI to configure a "site"
- Admin provides a GitHub repo URL (with auth options)
- System pulls the repo branch, runs the build command, copies `dist` to a
  configured directory
- Admin triggers builds from the UI

Grew to include user accounts with roles, then a second repo auth method and
email-based password resets.

---

## 2. Decisions log

### Round 1 — core stack

| Question | Decision | Notes |
| --- | --- | --- |
| Backend | Node + Express + TypeScript | Same language as UI |
| Persistence | SQLite | Implemented with built-in `node:sqlite` → **zero native deps**, nothing to compile on the VPS |
| GitHub auth | SSH deploy key | Plus a "public repo / HTTPS" escape hatch I added |
| Build isolation | **Run directly on host** | Explicitly chosen, against my recommendation of Docker |
| Deploy strategy | **Both, selectable per site** | `releases` (atomic symlink) or `direct` |
| Service host | pm2 | `ecosystem.config.cjs` |

**My pushback:** I recommended Docker containers per build; the choice was host
execution. Consequence: a repo's `install`/`build` scripts run with Lift-Off's own
privileges. Documented in README + in the Settings page UI. Acceptable for
trusted repos only.

**Deviation I made:** user selected SSH-only auth, but I also wired up
`authType: 'none'` for public repos over HTTPS — a two-line branch that avoids a
dead end. Noted so it's a conscious inclusion, not drift.

**Additions beyond the brief:** rollback (only meaningful because the
`releases` strategy was chosen), a connection-test button, a live SSE log viewer.

### Round 2 — users and roles

I pushed back on the original sketch (admin → superuser who can add others →
user?), arguing "admin" and "superuser" were the same power with two names, and
that the genuinely missing tier was an **operator** role — someone who can ship
but not reconfigure.

| Question | Decision |
| --- | --- |
| Roles | **Admin + Deployer** (dropped superuser tier) |
| Bootstrap account | **Protect the first account** (owner) |
| Login identifier | **Username** (not email) |
| Deployer scope | **Only assigned sites** ← this one adds a per-site allowlist |

Note on the last one: I flagged that per-site assignment is "the beginnings of the
org structure you said you didn't want", and it was chosen anyway. So there is a
small amount of scoping after all — a `user_sites` join table. No groups, no
teams, no inheritance.

### Round 3 — PAT auth + email password reset

| Question | Decision | Notes |
| --- | --- | --- |
| Second auth method | **Personal access token over HTTPS** | User picked PAT explicitly; **not** GitHub App |
| Reset identifier | **Username** for the request; email only on the backend | Email never becomes a login identifier |
| SMTP config | **Stored in the UI** (settings table), admin-editable | Not env vars, so an admin can change it without a redeploy |
| Reset token | 32 random bytes, stored **hashed**, 60 min, **single use** | DB leak can't be replayed |
| Reset enumeration | Generic response **always**, work done **after** the response | Body *and* timing are constant |

**Design calls I made, and why:**

- **PAT never touches argv or `.git/config`.** Injected via `GIT_CONFIG_COUNT` /
  `GIT_CONFIG_KEY_0=http.extraHeader` / `GIT_CONFIG_VALUE_0="Authorization: Basic
  base64(x-access-token:TOKEN)"`. `argv` shows up in `ps`; `.git/config` persists
  in the workspace on disk. Both leak the token to anyone who can look.
- **`public_url` setting is required for resets.** Building a link from the
  request's `Host` header would let an attacker poison the reset email's target.
- **`users.session_version`.** Bumped on password change/reset, carried in the JWT,
  re-checked by `requireAuth`. Without it, "reset your password because it may be
  compromised" leaves the attacker's session alive. Legacy tokens carry no `sv`
  and default to `1`, so the upgrade itself doesn't log anyone out.
- **Email uniqueness is a partial index** (`WHERE email IS NOT NULL`) so the many
  users with no recovery email don't collide on `NULL`.
- **Deployers can't see other people's emails**; the DTO only carries your own.
- **`nodemailer`** chosen over hand-rolling SMTP — pure JS, no native deps, keeps
  the "nothing to compile on the VPS" property.
- Admin can still set a password directly from **Users**, so the system is never
  dependent on email working.

### Round 4 — validate connection + discover scripts from the form

Ask: on the site form, after choosing a repo and auth, a **Validate connection**
button that shows status and, on success, lists runnable commands found in
`package.json` **on the right**. "Let's see if this works before we improve it."

| Question | Decision | Notes |
| --- | --- | --- |
| Endpoint | **`POST /api/sites/validate`** — takes the form's values, no site id required | The create form has no site to `POST /:id/test` against |
| Reading `package.json` | **Shallow single-branch fetch into a scratch dir**, then `git show FETCH_HEAD:package.json` | Host-agnostic — no GitHub API, works for SSH/PAT/none |
| Discovered scripts | **Right-hand aside on the form**; clicking a script sets the build command | The aside appears only after a validation run |
| Who may call it | **Admin only** | Editing sites is admin-only, and the request may carry a token |

**Design calls I made, and why:**

- **Optional `siteId` on the request** reuses the saved secret. A form edit never
  has to round-trip the token/key to the browser just to validate.
- **SSH cannot validate before save.** The deploy key is generated when the site
  is first saved, so on the create form the button is disabled with an explanation
  rather than making a pointless unauthenticated call.
- **Scratch clone is always removed** (`finally`), and both network steps carry
  timeouts (60s) so a slow/hostile remote can't hold a request open forever.
- **`buildGitEnv` now takes a narrow `GitAuth` interface**, so an unsaved config
  (form values + any stored secret) can reuse the exact same auth injection as a
  real deploy.
- **Build command comes back as a label, not an executed thing.** The list just
  shows `npm run build` / `pnpm build` etc.; nothing from the repo is run here.

**Deliberately not done yet** (the "improve on the idea" round): suggesting the
install command from lockfiles, and surfacing the scripts on the site detail page.

### Round 5 — renamed to Lift-Off + published

Renamed the project from "Deplego" to **Lift-Off** and pushed it to
<https://github.com/Nabih/lift-off> (public). Chose a **full internal rename**
over a display-only one, since nothing is deployed yet, so there was no
compatibility cost.

| Kind | Old | New |
| --- | --- | --- |
| Display name | Deplego | Lift-Off |
| Env prefix | `DEPLEGO_*` | `LIFTOFF_*` |
| npm packages | `deplego`, `@deplego/*` | `liftoff`, `@liftoff/*` |
| Cookie | `deplego_session` | `liftoff_session` |
| DB file | `deplego.db` | `liftoff.db` |
| pm2 app name | `deplego` | `liftoff` |
| SSH key comment | `deplego:<name>` | `liftoff:<name>` |
| Log tag | `[deplego]` | `[liftoff]` |

**Why a full rename and not just the display name:** the env prefix, cookie, and
DB filename are all cheap to change now and would be a breaking migration later.
Doing it before the first deploy means there is exactly one name in the codebase
and no "legacy Deplego" special-casing to remember.

**Note:** `SUMMARY.md` (this file) is a personal working record and was published
alongside the code — it contains design rationale, not secrets. Say the word if it
should be moved out of the public repo.

### Round 6 — assign access from the site too, with filters

The assignment control only existed on the user side (**Users → Edit → Assigned
sites**). It was reachable but only from one direction, and the lists had no
filter. Added the other direction and a filter to both.

| Question | Decision |
| --- | --- |
| Where else to assign | **Site create/edit form**, new "User access" card listing Deployers |
| New endpoint | **`PUT /api/sites/:id/access`** — sets the site's user set atomically (admin-only) |
| Filter | One shared `CheckboxList` component used by both grids |

**Design calls I made, and why:**

- **A site-scoped endpoint, not a loop of `PATCH /api/users/:id`.** Assigning
  from the site side would otherwise mean N requests and a half-applied state if
  one failed. `setSiteUsers` replaces the site's rows inside one transaction.
- **Only Deployer ids are stored.** An Admin id in the payload is silently
  dropped — Admins reach every site regardless, so storing it would be a lie the
  UI then has to explain. Verified by test.
- **Create-form assignment is applied after `POST /api/sites` returns**, because
  the site id does not exist before then. The card says so in create mode rather
  than pretending it saved with the site.
- **Shared `CheckboxList`** instead of duplicating filter + grid markup in two
  pages; it also reports "N of M selected", which matters for a multi-select.
- The site-scoped endpoint is admin-only like every other site mutation, even
  though Deployers can read their sites.

### Round 7 — branch dropdown from the validated repository

Adding a site meant typing the branch by hand, even though `validateRepo` had
already been returning the remote's branch names since round 4 — the form simply
threw them away. Now a successful **Validate connection** fills a branch
dropdown, and the free-text box remains the fallback.

| Question | Decision |
| --- | --- |
| Where branches come from | The existing `branches` array on the validation response — **no new request or endpoint** |
| When to show the dropdown | Only when validation returned at least one branch |
| Fallback | The original **text input**, whenever the list is empty |

**Design calls I made, and why:**

- **The branch list is its own state, not read off `validation`.** The form
  clears `validation` whenever the branch changes (the connection result is
  branch-specific), so deriving the dropdown from it would make the dropdown
  delete itself the moment you picked from it. The list is scoped to the
  *repository*, so it is cleared only when `repoUrl` / `authType` / `accessToken`
  change — those can point somewhere else entirely.
- **A branch that is not on the remote still appears as an option**, labelled as
  the current value, so editing a site whose branch was deleted doesn't silently
  swap the branch underneath you. An empty value shows as "Select a branch…" and
  the field stays `required`, so the form can't submit a blank branch.
- **No auto-fetch on typing the URL.** Validation is the existing, explicit
  "repo data" step — it is the only path that also works for private repos
  (where credentials are needed) and for SSH (where the key exists only after
  save). Firing requests per keystroke would be noisy and mostly fail.
- Branch names come back from `git ls-remote`, so a host that doesn't advertise
  branches (e.g. dumb HTTP) naturally yields an empty list and the text box
  stays — no special-casing needed.

**Layout:** **Validate connection** now sits *beside* the **Authentication**
select (with its Reachable / Branch-missing badge), and **Branch** moved out of
the top row to directly underneath that block. The button and the field it
depends on are then read together, which is what the create-form case needs:
validate is disabled until SSH sites are saved, and that reason is only obvious
next to the auth control. Repository order is now: name → URL → auth (+validate)
→ token → branch.

**Picking a branch re-checks automatically.** Choosing a branch from the dropdown
fires the same validation with that branch, so the script list and the badge
follow the selection without a second click. The guards that make this safe:

- **Only the dropdown triggers it.** The free-text fallback does not, because
  auto-checking on every keystroke would fire a request per character.
- **A monotonic request id.** Each run takes the next id and only applies its
  result if it is still the newest, so switching branches quickly cannot let a
  slow earlier response overwrite the newer one; `validating` is likewise only
  cleared by the winning request.
- **A failed auto-check no longer empties the branch list.** The old catch
  cleared it (fine on the manual path, where the list was just re-fetched), but
  on the auto path a transient error would make the dropdown vanish mid-edit.
  The list is now only cleared when `repoUrl` / `authType` / `accessToken`
  change, which is the only thing that can make it wrong.

### Round 8 — re-deploy awareness, forced deploys, and GitHub links

Deployments recorded only a commit sha, "Deploy now" fired with no confirmation,
and nothing said whether a deploy would reproduce exactly what was already live.
Added branch capture, a pre-deploy check, a forced re-deploy path with a label, and
GitHub links for the commit and branch.

| Question | Decision |
| --- | --- |
| What "live" means | The newest **successful** deployment that recorded a commit |
| Detecting a no-op deploy | Compare `site.branch` + the remote head (`git ls-remote`) against the live branch + commit |
| Forcing | `POST /api/sites/:id/deploy { force }`; without it a matching deploy is refused `409` |
| Label | `deployments.redeploy`, set by the server from the same check |
| Links | `repoUrl` on the deployment DTO; the web derives GitHub URLs |

**Design calls I made, and why:**

- **The force requirement lives on the server, not only in the dialog.** The UI
  asks `GET /deploy-check` to decide whether to show the Force tick box, but the
  deploy endpoint repeats the check. So a direct API call cannot slip past it, and
  the `re-deployment` label is the server's judgement rather than a client claim.
- **"Live" is database-derived, and rollbacks record their target commit.** The
  newest successful deployment with a commit is what serves. A rollback writes the
  commit it reverted to — recovered from the release name's short sha and mapped
  back to the full sha and branch via the deployment that produced it — so the check
  stays correct after a rollback instead of comparing against the superseded release.
- **A failed remote lookup never blocks a deploy.** If `ls-remote` fails the check
  reports "not a re-deploy" and the deploy proceeds, failing later with a clearer
  message if the remote really is unreachable. The check is convenience, not a gate
  on broken connectivity.
- **Both branch and commit must match.** Change the site's branch and live `branch`
  no longer equals `site.branch`, so the next deploy is a normal one even if the
  commit is unchanged — which is exactly the case a naive commit-only check would
  get wrong.
- **The branch link points at the tree at that commit** (`/tree/<sha>`), i.e. what
  was actually deployed, not the branch's current tip.
- **Confirmation is always required**, re-deploy or not: the dialog is the only way
  in, and the check runs while it is open. Re-deploys additionally disable the
  button until Force is ticked.

---

## 3. How it works

```
GitHub repo → git fetch/reset to <branch> → install cmd → build cmd → dist/ → target dir
```

Deploy strategies:

- **releases** (default) — each build → `releases/<YYYYMMDD-HHmmss-mmm>-<sha7>/`,
  then the `current` symlink is swapped via a single atomic `rename(2)`. Old
  releases pruned, never the live one. Enables zero-downtime + rollback. The
  millisecond component matters: recency is inferred by sorting names.
- **direct** — target dir wiped and replaced. Brief window with no files, no rollback.

Queue: single global in-process queue, `LIFTOFF_MAX_CONCURRENT_BUILDS` (default 1).

Live logs: SQLite persistence + in-process `EventEmitter` fan-out → SSE.

Repo auth: `ssh` (per-site keypair, encrypted at rest), `token` (PAT injected as an
HTTP header via `GIT_CONFIG_*` env vars), or `none` (public HTTPS).

---

## 4. Permission model

| | Admin | Deployer |
| --- | --- | --- |
| View sites / deployments / logs | every site | assigned sites only |
| Deploy / roll back | every site | assigned sites only |
| Create / edit / delete sites | yes | no |
| Regenerate deploy keys | yes | no |
| Manage users | yes | no |
| Set recovery emails | any account | own only |
| Configure SMTP / send test mail | yes | no |
| Read build env var **values** | yes | no — names only |
| Test repo connection | yes | yes (read-only) |
| Validate repo + list package.json scripts | yes | no |

- **Owner** = first account. Admin that cannot be deleted, disabled, or demoted;
  only the owner can modify the owner.
- Admins bypass the site assignment list entirely.
- Assignments can be edited from **either** side (a user's sites, or a site's
  users) and both lists are filterable; the two views write to the same
  `user_sites` table, so they never disagree.
- Roles are re-read from the DB on **every request** (not trusted from the JWT),
  so disable/delete/demote takes effect immediately on live sessions.
- Sessions are additionally invalidated by **session version**: a password change
  or reset bumps it, so sessions issued before it stop working. Changing your own
  password re-issues your current session and drops your others.

**Security choices worth remembering:**

- Env var **values** are redacted for Deployers. Rationale: a Deployer can already
  trigger a build, so handing them the build's API keys on top is unnecessary
  exposure. **If Deployers ever need to edit those values, revisit this.**
- Sign-in is identical for unknown-user and wrong-password; unknown usernames are
  verified against a decoy scrypt hash so timing can't enumerate accounts.
- Password reset is identical for existing/non-existing usernames, and responds
  before doing the lookup, so neither the body nor the timing leaks anything.
- Route access is enforced server-side. The UI hiding buttons is cosmetic only.

---

## 5. Stack / versions

- Node ≥ 22.5 required (uses built-in `node:sqlite`); 24.x used locally.
- Backend: express 4.22, zod 3.25, execa 9.6, jsonwebtoken 9.0, cookie-parser, cors, **nodemailer 10**
- Frontend: react 18.3, react-router-dom 6.30, vite 6.4
- No DB server, no Docker, no native compilation.

**Key dependency decision:** `node:sqlite` via `createRequire` (its typings aren't
in older `@types/node`) instead of `better-sqlite3`. Trade-off: zero native builds,
but Node ≥ 22.5 is a hard floor — a Node 20 VPS would break.

---

## 6. File map

```
server/src/
  index.ts        app, route mounting, static UI, HttpError-aware error handler
  auth.ts         user lookup, scrypt, JWT sessions, requireAuth, session versioning,
                  owner bootstrap + legacy-password migration
  guards.ts       HttpError, requireUser, requireAdmin, canAccessSite, firstIssue, emailSchema
  config.ts       paths, ports, limits
  crypto.ts       AES-256-GCM + scrypt
  db.ts           schema (sites, deployments, deployment_logs, settings, users,
                  user_sites, password_resets) + ensureColumn migrations
  store.ts        All SQL queries (users, sites, user_sites assignments)
  git.ts          clone/fetch/reset, SSH + token auth env, connection test,
                  form-time validation + shallow package.json read
  ssh.ts          ssh-keygen keypair generation
  runner.ts       queue, deploy + rollback pipeline
  deploy.ts       releases vs direct, atomic symlink, prune, rollback, target validation
  log.ts          log persistence + live publish
  logbus.ts       EventEmitter fan-out
  mail.ts         SMTP transport from UI settings, reset + test emails
  password-reset.ts  single-use hashed tokens (60 min)
  ratelimit.ts    in-memory sliding-window limiter
  process.ts      streaming command execution, line splitting (capture supports timeouts)
  express-augment.d.ts   adds req.user
  routes/         auth.ts, users.ts, sites.ts, deployments.ts (incl. SSE), settings.ts
web/src/
  App.tsx, api.ts, auth.tsx, format.ts
  components/     Layout, LogViewer, StatusBadge, CopyButton, EnvVarsEditor,
                  CheckboxList (filtered multi-select for access assignment)
  pages/          Login, ForgotPassword, ResetPassword, Sites, SiteForm, SiteDetail,
                  Deployments, Deployment, Users, Settings
```

Data dir (gitignored): `liftoff.db`, `secret.key`, `keys/`, `workspaces/`.

---

## 7. Verification log

Verified with real runs, not mocks.

**Build pipeline** (against a local fixture repo served over dumb HTTP, 28 checks):
- clone → `npm run build` → release folder → atomic symlink → content served
- second deploy picked up a new commit; pruning honoured `keep_releases` (2)
- releases listed newest-first and the live one flagged `isCurrent`
- rollback restored the previous release's content; recorded as `kind: rollback`
- direct strategy wrote into the target with no `current` symlink; rollback refused
- `validateTargetDir` rejected `/`; absolute and `..` dist dirs rejected

**Permissions + roles** (76 checks, all passing): deployer site scoping (list, read,
deploy, test, releases all 403 on unassigned sites), env-value redaction with names
preserved, deployers locked out of site/user/settings administration, owner
protection against other admins, self-protection, live effect of assignment
changes, session versioning (admin reset and self-change), email validation +
case-insensitive uniqueness, disabled-account session rejection, anonymous 401s.

**PAT auth + password reset** (39 checks, all passing, with a fake HTTP git server
that requires the injected `Authorization` header and a fake SMTP server):
- token site connects and deploys; the git server confirmed it received
  `Basic base64(x-access-token:goodtoken)`
- a wrong token fails the connection test; token auth without a token, or with an
  SSH-style URL, is rejected
- the token is never returned; `hasAccessToken` is
- SMTP settings save, reload, and never leak the password; test email delivered
- recovery email requires the password, is normalised, and is exposed via `/me`
- `forgot-password` returned byte-identical responses for a real and a fake
  username; the email arrived with a working link; the token validated, refused a
  weak password, reset successfully, invalidated live sessions, and could not be
  reused; the old password stopped working and the new one worked
- five rapid requests produced only two sends (throttling)

**Form-time validation + script discovery** (25 checks, all passing, against a
fixture repo served over **smart HTTP** with the same required `Authorization`
header, using Node's `git http-backend` as the backend):
- anonymous validate → 401; missing repo URL → 400
- token validation succeeded and returned `packageJson.name`, `packageManager`
  (`pnpm`), and all four scripts with their exact command text; the git server
  confirmed it received the injected header
- a bad token → `ok: false` with no `packageJson`; the message carried git's own
  exit line
- a missing branch → `ok: true` but `branchFound: false`, other branches listed,
  no `packageJson`
- token auth without a token and SSH without a saved key each returned a specific
  explanation instead of a bare failure
- validating with only a `siteId` (no typed token) reused the stored token — the
  git server saw fresh authenticated hits
- a Deployer was refused (403)
- no `validate-*` scratch directory was left behind in `workspaces/`

**Site-side access assignment** (24 checks, all passing):
- `PUT /api/sites/:id/access` stored two Deployers on a site and both then saw
  it in their own site list
- a Deployer saw exactly their assigned site and got **403** on an unassigned one
- one Deployer held two sites (granted from two different sites)
- a site with nobody assigned stayed invisible to Deployers but **visible to
  admins**
- revoking took effect on the *next request* on a live session: the revoked
  Deployer kept their other site and immediately got 403 on the revoked one
- an Admin id sent in the payload was **not stored**; a second Admin reached the
  site with no assignment at all
- guardrails: unknown site → 404, malformed body → 400, Deployer → 403,
  anonymous → 401, and clearing to an empty set worked

**Branch dropdown** (UI-only, no new server behaviour): the round-4 validation
suite still passes in full (25 checks), including *"other branches are still
listed"* — the `branches` array the dropdown renders was already covered. The
change is presentational, so it was verified by typecheck + production build
rather than a new headless suite; the submit path and `SiteInput.branch` are
untouched.

**Re-deploy detection + forced deploys** (34 checks, all passing, against a
dumb-HTTP git fixture that can be pushed to mid-test):
- the first deploy recorded `branch: master` and the exact head commit, and was
  not a re-deployment
- a second deploy with no new commit: `deploy-check` reported the live commit
  equals the remote head and `wouldRedeploy: true`
- a plain `POST /deploy` was refused `409 ALREADY_LIVE`; the same request with
  `force: true` succeeded, re-used the commit, and was labelled `redeploy: true`
- after a new commit the check flipped to `wouldRedeploy: false` and the deploy
  went through with no force
- listings and single-deployment GETs carried `branch` and `repoUrl`
- a rollback recorded the **earlier** commit (not the one it rolled back from),
  kept the branch, and `deploy-check` then reported that older commit as live
- changing the site branch made the next check `wouldRedeploy: false` even with
  the commit unchanged

**Migrations** (11 checks, all passing):
- pre-users DB with only a legacy `admin_password_hash`, booted with no
  `LIFTOFF_ADMIN_PASSWORD` → owner created from the old hash, signed in with the
  old password, flagged `isOwner`, not flagged as generated
- old-schema DB (new columns/tables dropped, incl. a pre-existing site with env
  vars and a pre-existing deployer user) → booted clean, columns re-added, data
  intact, and the new `access_token` / `email` columns usable immediately,
  existing users backfilled to `session_version = 1`

**Bug this round's testing actually caught:** release folders were named with a
**second**-precision timestamp, so two deploys finishing inside the same second
sorted by their commit SHA instead of by time. Rollback then picked the wrong
release — or, as the test showed, refused with "No previous release is available"
despite two existing releases. Pruning and the releases list shared the flaw.
Fixed by adding milliseconds plus a uniqueness suffix. This is exactly the kind of
bug that only shows up when deploys are fast; worth keeping the test.

Two test-harness bugs, for the record (not product bugs):
- A fake SMTP server that split the DATA stream on CRLF and looked for a `.` line
  mis-detected the terminator when the boundary landed mid-chunk, and the
  resulting connection reset made a *working* mail path look broken. Rewrote it to
  search the raw stream for the CRLF-dot-CRLF terminator. A separate concurrency
  run (5 simultaneous sends) then confirmed the mail code was fine all along.
- The reset link looked invalid because the email body is quoted-printable: the
  `=` in `?token=` arrives as `=3D` and long lines are soft-wrapped with `=\r\n`.
  The test needed a real QP decode. The production link was correct.

One test-script bug worth remembering: a bash helper interpolated `o[$1]` into
`o[id]` instead of `o["id"]`, silently returning empty and making a passing test
look like a failure. Fixed by passing the field via `process.argv`.

**Another harness bug (round 4):** the `git http-backend` CGI bridge parsed the
status with `firstLine.match(/(\d+)/)`, but git omits the `Status:` line for 200
responses and sends `Expires: Fri, 01 Jan 1980 …` first — so the code read the
status as `1` and `writeHead` threw. Fixed by checking for a leading `Status:`
and defaulting to 200. The product was never affected.

---

## 8. Gotchas / things to know

- **Node ≥ 22.5 is a hard requirement.** `node:sqlite` is experimental and emits
  nothing fatal, but an older Node will simply not have it.
- **SSE through a proxy needs buffering off.** nginx: `proxy_buffering off;`.
  Lift-Off already sends `X-Accel-Buffering: no`.
- **`LIFTOFF_COOKIE_SECURE=true`** must be set once serving over HTTPS, or leave
  false on plain HTTP — otherwise login silently fails.
- **Build output dir cannot be the repo root** and cannot contain `..`.
- **Interrupted builds** (server restart mid-build) are marked failed on next boot
  rather than left "running".
- **Deleting a site** does not remove files already deployed to its target dir.
- **Release names are time-ordered, so the timestamp must stay monotonic.** They
  carry milliseconds now; if the naming scheme is ever changed, keep
  lexicographic order == chronological order or rollback/pruning break again.
- **Reset emails are sent after the HTTP response returns** (that's how the
  timing is kept constant). Anything that reads the mail *synchronously* after
  calling `forgot-password` will race it — poll instead.
- **nodemailer encodes bodies as quoted-printable**, so anything parsing a reset
  link out of a raw email must decode `=3D` and `=\r\n`.
- **Password-reset state is in-memory rate limiting only** — per process, so
  multiple instances behind a load balancer would each keep their own window.
- **Validation reads `package.json` with `git fetch --depth 1`**, which needs a
  *smart* remote (GitHub/GitLab/self-hosted git-http-backend all qualify). A repo
  served as static files over dumb HTTP will connect and list branches but return
  no scripts — degradation, not an error.
- **The validate button needs a saved site for SSH.** The deploy key only exists
  after saving, so on the create form it stays disabled with an explanation.
- The UI has no rate limiting on login and no 2FA; behind TLS + IP allowlist is
  the assumed deployment.

---

## 9. Open items / possible next steps

- [ ] Deploy to the VPS: `.env`, `npm run build`, `pm2 start ecosystem.config.cjs`, nginx + TLS + allowlist
- [ ] Set `mail_public_url` to the real external URL once behind TLS, or reset
      links will point at localhost
- [ ] Decide whether Deployers should see env var values (currently redacted)
- [ ] Improve the validate idea (round 4 was the first cut): suggest the install
      command from lockfiles, and show discovered scripts on the site detail page too
- [ ] Optional: per-site scoping for Admins (currently all Admins reach all sites)
- [ ] Optional: webhook-triggered deploys on push (no token/endpoint built yet)
- [ ] Optional: GitHub App auth (PAT was chosen instead; an app would need key
      management and installation tokens)
- [ ] Optional: pending-email verification (an admin can currently set an address
      that nobody has confirmed is reachable)
- [ ] If untrusted repos are ever connected: move builds into containers after all
