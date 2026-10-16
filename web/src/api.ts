import type {
  AuthType,
  AuthUser,
  ConnectionTest,
  DeployCheck,
  Deployment,
  LogLine,
  MailSettings,
  Release,
  Site,
  SiteInput,
  UserAccount,
  UserInput,
} from './types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers:
      options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      (payload as { error?: string } | null)?.error ??
      `Request failed with status ${response.status}.`;
    throw new ApiError(response.status, message);
  }

  return payload as T;
}

export const api = {
  // ---- auth -------------------------------------------------------------
  login: (username: string, password: string) =>
    request<{ ok: boolean; user: AuthUser; usingGeneratedPassword: boolean }>(
      '/api/auth/login',
      { method: 'POST', body: { username, password } },
    ),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () =>
    request<{
      authenticated: boolean;
      user: AuthUser;
      usingGeneratedPassword: boolean;
    }>('/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),
  setEmail: (password: string, email: string) =>
    request<{ ok: boolean; user: AuthUser | null }>('/api/auth/email', {
      method: 'PATCH',
      body: { password, email },
    }),
  forgotPassword: (username: string) =>
    request<{ ok: boolean; message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: { username },
    }),
  checkResetToken: (token: string) =>
    request<{ valid: boolean; reason: string | null }>(
      `/api/auth/reset-password/${encodeURIComponent(token)}`,
    ),
  resetPassword: (token: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword },
    }),

  // ---- settings (admin only) -------------------------------------------
  getMailSettings: () => request<MailSettings>('/api/settings/mail'),
  saveMailSettings: (input: Partial<MailSettings> & { pass?: string }) =>
    request<MailSettings>('/api/settings/mail', { method: 'PUT', body: input }),
  sendTestEmail: (to?: string) =>
    request<{ ok: boolean; to: string }>('/api/settings/mail/test', {
      method: 'POST',
      body: { to },
    }),

  // ---- users (admin only) ----------------------------------------------
  listUsers: () => request<{ users: UserAccount[] }>('/api/users'),
  createUser: (input: UserInput) =>
    request<UserAccount>('/api/users', { method: 'POST', body: input }),
  updateUser: (id: string, input: Partial<UserInput>) =>
    request<UserAccount>(`/api/users/${id}`, { method: 'PATCH', body: input }),
  deleteUser: (id: string) =>
    request<{ ok: boolean }>(`/api/users/${id}`, { method: 'DELETE' }),

  // ---- sites ------------------------------------------------------------
  listSites: () => request<{ sites: Site[] }>('/api/sites'),
  getSite: (id: string) => request<Site>(`/api/sites/${id}`),
  createSite: (input: SiteInput) =>
    request<Site>('/api/sites', { method: 'POST', body: input }),
  updateSite: (id: string, input: Partial<SiteInput>) =>
    request<Site>(`/api/sites/${id}`, { method: 'PATCH', body: input }),
  deleteSite: (id: string) =>
    request<{ ok: boolean }>(`/api/sites/${id}`, { method: 'DELETE' }),
  regenerateSshKey: (id: string) =>
    request<Site>(`/api/sites/${id}/ssh-key`, { method: 'POST' }),
  setSiteAccess: (id: string, userIds: string[]) =>
    request<{ ok: boolean; userIds: string[] }>(`/api/sites/${id}/access`, {
      method: 'PUT',
      body: { userIds },
    }),
  testSite: (id: string) =>
    request<ConnectionTest>(`/api/sites/${id}/test`, { method: 'POST' }),
  validateSite: (input: {
    siteId?: string;
    repoUrl: string;
    branch: string;
    authType: AuthType;
    accessToken?: string;
  }) => request<ConnectionTest>('/api/sites/validate', { method: 'POST', body: input }),
  deploySite: (id: string, force = false) =>
    request<{ deploymentId: string }>(`/api/sites/${id}/deploy`, {
      method: 'POST',
      body: { force },
    }),
  deployCheck: (id: string) => request<DeployCheck>(`/api/sites/${id}/deploy-check`),
  rollbackSite: (id: string) =>
    request<{ deploymentId: string }>(`/api/sites/${id}/rollback`, {
      method: 'POST',
    }),
  listReleases: (id: string) =>
    request<{ releases: Release[] }>(`/api/sites/${id}/releases`),

  // ---- deployments ------------------------------------------------------
  listDeployments: (siteId?: string, limit = 50) => {
    const params = new URLSearchParams();
    if (siteId) params.set('siteId', siteId);
    params.set('limit', String(limit));
    return request<{ deployments: Deployment[] }>(
      `/api/deployments?${params.toString()}`,
    );
  },
  getDeployment: (id: string) => request<Deployment>(`/api/deployments/${id}`),
  deploymentLogs: (id: string, afterSeq = 0) =>
    request<{ lines: LogLine[]; status: string }>(
      `/api/deployments/${id}/logs?afterSeq=${afterSeq}`,
    ),
};
