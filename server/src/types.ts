export type DeployStrategy = 'releases' | 'direct';
export type AuthType = 'ssh' | 'token' | 'none';
export type DeploymentStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type DeploymentKind = 'deploy' | 'rollback';
export type Role = 'admin' | 'deployer';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  email: string | null;
  role: Role;
  is_owner: number;
  disabled: number;
  /** Incremented on password change so old sessions stop working. */
  session_version: number;
  created_at: string;
  created_by: string | null;
  last_login_at: string | null;
}

/** Account as exposed by the API. Never leaks the password hash. */
export interface UserDTO {
  id: string;
  username: string;
  /** Used only for password-reset mail, never shown to other users. */
  email: string | null;
  role: Role;
  isOwner: boolean;
  disabled: boolean;
  createdAt: string;
  createdBy: string | null;
  lastLoginAt: string | null;
  /** Site ids this user is assigned to; empty for admins (they see all). */
  siteIds: string[];
}

export function toUserDTO(row: UserRow, siteIds: string[]): UserDTO {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    isOwner: Boolean(row.is_owner),
    disabled: Boolean(row.disabled),
    createdAt: row.created_at,
    createdBy: row.created_by,
    lastLoginAt: row.last_login_at,
    siteIds: row.role === 'admin' ? [] : siteIds,
  };
}

export interface SiteRow {
  id: string;
  name: string;
  repo_url: string;
  branch: string;
  auth_type: AuthType;
  ssh_private_key: string | null;
  ssh_public_key: string | null;
  access_token: string | null;
  install_command: string;
  build_command: string;
  dist_dir: string;
  target_dir: string;
  deploy_strategy: DeployStrategy;
  keep_releases: number;
  env_vars: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Site as exposed by the API. Never leaks the private key. */
export interface SiteDTO {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  authType: AuthType;
  sshPublicKey: string | null;
  /** True when a personal access token is stored. The token itself is never sent. */
  hasAccessToken: boolean;
  installCommand: string;
  buildCommand: string;
  distDir: string;
  targetDir: string;
  deployStrategy: DeployStrategy;
  keepReleases: number;
  envVars: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentRow {
  id: string;
  site_id: string;
  kind: DeploymentKind;
  status: DeploymentStatus;
  /** Branch the deployment built. Null for rows created before this was recorded. */
  branch: string | null;
  commit_sha: string | null;
  commit_message: string | null;
  /** 1 when forced despite the branch + commit already being live. */
  redeploy: number;
  /** Release folder created by the deploy (releases strategy only). */
  release_name: string | null;
  triggered_by: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface DeploymentDTO {
  id: string;
  siteId: string;
  siteName?: string;
  /** Remote URL of the site, so the UI can link commits and branches. */
  repoUrl?: string | null;
  kind: DeploymentKind;
  status: DeploymentStatus;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  redeploy: boolean;
  triggeredBy: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export type LogLine = {
  seq?: number;
  ts: string;
  stream: 'info' | 'stdout' | 'stderr' | 'error' | 'success';
  line: string;
}

export function toSiteDTO(row: SiteRow): SiteDTO {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    branch: row.branch,
    authType: row.auth_type,
    sshPublicKey: row.ssh_public_key,
    hasAccessToken: Boolean(row.access_token),
    installCommand: row.install_command,
    buildCommand: row.build_command,
    distDir: row.dist_dir,
    targetDir: row.target_dir,
    deployStrategy: row.deploy_strategy,
    keepReleases: row.keep_releases,
    envVars: safeJsonObject(row.env_vars),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toDeploymentDTO(row: DeploymentRow): DeploymentDTO {
  const start = row.started_at ? Date.parse(row.started_at) : null;
  const end = row.finished_at ? Date.parse(row.finished_at) : null;
  return {
    id: row.id,
    siteId: row.site_id,
    kind: row.kind,
    status: row.status,
    branch: row.branch ?? null,
    commitSha: row.commit_sha,
    commitMessage: row.commit_message,
    redeploy: Boolean(row.redeploy),
    triggeredBy: row.triggered_by,
    error: row.error,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: start && end ? end - start : null,
  };
}

function safeJsonObject(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
