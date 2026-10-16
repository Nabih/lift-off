export type DeployStrategy = 'releases' | 'direct';
export type AuthType = 'ssh' | 'token' | 'none';
export type Role = 'admin' | 'deployer';

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  isOwner: boolean;
}

export interface UserAccount {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  isOwner: boolean;
  disabled: boolean;
  createdAt: string;
  createdBy: string | null;
  lastLoginAt: string | null;
  siteIds: string[];
}

export interface UserInput {
  username: string;
  password?: string;
  email?: string;
  role: Role;
  siteIds: string[];
  disabled?: boolean;
}
export type DeploymentStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled';
export type DeploymentKind = 'deploy' | 'rollback';

export interface Site {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  authType: AuthType;
  sshPublicKey: string | null;
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

export interface SiteInput {
  name: string;
  repoUrl: string;
  branch: string;
  authType: AuthType;
  /** Only sent when the admin types a new token; blank keeps the stored one. */
  accessToken?: string;
  installCommand: string;
  buildCommand: string;
  distDir: string;
  targetDir: string;
  deployStrategy: DeployStrategy;
  keepReleases: number;
  envVars: Record<string, string>;
  enabled: boolean;
}

export interface Deployment {
  id: string;
  siteId: string;
  siteName?: string;
  kind: DeploymentKind;
  status: DeploymentStatus;
  commitSha: string | null;
  commitMessage: string | null;
  triggeredBy: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export type LogStream = 'info' | 'stdout' | 'stderr' | 'error' | 'success';

export interface LogLine {
  seq?: number;
  ts: string;
  stream: LogStream;
  line: string;
}

export interface Release {
  name: string;
  path: string;
  isCurrent: boolean;
}

export interface PackageJsonScript {
  name: string;
  command: string;
}

export interface PackageJsonInfo {
  name: string | null;
  packageManager: string | null;
  scripts: PackageJsonScript[];
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
  branches: string[];
  /** Only returned by /api/sites/validate (the site form). */
  branchFound?: boolean;
  packageJson?: PackageJsonInfo | null;
}

export interface MailSettings {
  publicUrl: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  hasPassword: boolean;
  configured: boolean;
}
