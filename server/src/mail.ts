import nodemailer, { type Transporter } from 'nodemailer';
import { decrypt, encrypt } from './crypto.js';
import { getSetting, setSetting } from './db.js';

/**
 * SMTP configuration, stored in the settings table and edited from the UI by an
 * admin. The password is encrypted at rest with the same key as site secrets.
 */
export interface MailConfig {
  /** Absolute base URL of this Lift-Off instance; used to build reset links. */
  publicUrl: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  /** Recipients notified when a deployment finishes. */
  notifyEmail: string;
}

/** Shape returned to the UI. The password is never included, only its presence. */
export interface MailSettingsDTO {
  publicUrl: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  hasPassword: boolean;
  notifyEmail: string;
  /** True when everything needed to send a reset email is present. */
  configured: boolean;
}

const KEYS = {
  publicUrl: 'mail_public_url',
  host: 'mail_smtp_host',
  port: 'mail_smtp_port',
  secure: 'mail_smtp_secure',
  user: 'mail_smtp_user',
  pass: 'mail_smtp_pass',
  from: 'mail_from',
  notifyEmail: 'mail_notify_email',
} as const;

/** Where deploy-finished notifications go until an admin changes it. */
export const DEFAULT_NOTIFY_EMAIL = 'nabih@email.com';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getMailConfig(): MailConfig | null {
  const host = getSetting(KEYS.host);
  const from = getSetting(KEYS.from);
  const publicUrl = getSetting(KEYS.publicUrl);
  if (!host || !from || !publicUrl) return null;

  const storedPassword = getSetting(KEYS.pass);
  return {
    publicUrl: trimTrailingSlash(publicUrl),
    host,
    port: Number(getSetting(KEYS.port)) || 587,
    secure: getSetting(KEYS.secure) === 'true',
    user: getSetting(KEYS.user) ?? '',
    pass: storedPassword ? decrypt(storedPassword) : '',
    from,
    notifyEmail: getSetting(KEYS.notifyEmail) ?? DEFAULT_NOTIFY_EMAIL,
  };
}

export function isMailConfigured(): boolean {
  return getMailConfig() !== null;
}

export function mailSettingsForUI(): MailSettingsDTO {
  return {
    publicUrl: getSetting(KEYS.publicUrl) ?? '',
    host: getSetting(KEYS.host) ?? '',
    port: Number(getSetting(KEYS.port)) || 587,
    secure: getSetting(KEYS.secure) === 'true',
    user: getSetting(KEYS.user) ?? '',
    from: getSetting(KEYS.from) ?? '',
    notifyEmail: getSetting(KEYS.notifyEmail) ?? DEFAULT_NOTIFY_EMAIL,
    hasPassword: Boolean(getSetting(KEYS.pass)),
    configured: isMailConfigured(),
  };
}

export interface MailSettingsInput {
  publicUrl: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** Omit or leave empty to keep the stored password. */
  pass?: string;
  from: string;
  /** Blank keeps the default recipient. */
  notifyEmail?: string;
}

export function saveMailSettings(input: MailSettingsInput): void {
  setSetting(KEYS.publicUrl, trimTrailingSlash(input.publicUrl.trim()));
  setSetting(KEYS.host, input.host.trim());
  setSetting(KEYS.port, String(input.port));
  setSetting(KEYS.secure, input.secure ? 'true' : 'false');
  setSetting(KEYS.user, input.user.trim());
  setSetting(KEYS.from, input.from.trim());
  const notify = (input.notifyEmail ?? '').trim();
  setSetting(
    KEYS.notifyEmail,
    notify && notify !== DEFAULT_NOTIFY_EMAIL ? notify : DEFAULT_NOTIFY_EMAIL,
  );
  if (input.pass !== undefined && input.pass !== '') {
    setSetting(KEYS.pass, encrypt(input.pass));
  }
}

function buildTransport(config: MailConfig, passwordOverride?: string): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user
      ? { user: config.user, pass: passwordOverride ?? config.pass }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function send(
  config: MailConfig,
  options: { to: string; subject: string; text: string; html: string },
): Promise<void> {
  const transport = buildTransport(config);
  try {
    await transport.sendMail({
      from: config.from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
  } finally {
    transport.close();
  }
}

export function resetUrlFor(config: MailConfig, token: string): string {
  return `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function sendPasswordResetEmail(
  config: MailConfig,
  to: string,
  username: string,
  resetUrl: string,
): Promise<void> {
  const minutes = 60;
  const text = [
    `Hello ${username},`,
    '',
    'Someone asked to reset the password for your Lift-Off account.',
    `Open this link within ${minutes} minutes to choose a new one:`,
    '',
    resetUrl,
    '',
    'If this was not you, you can ignore this message — your password has not changed.',
  ].join('\n');

  const html = `
    <div style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; line-height: 1.5;">
      <p>Hello ${escapeHtml(username)},</p>
      <p>Someone asked to reset the password for your Lift-Off account.
         Open the link below within ${minutes} minutes to choose a new one:</p>
      <p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p>
      <p style="color:#6b7280;font-size:13px;">If this was not you, you can ignore this
         message — your password has not changed.</p>
    </div>
  `.trim();

  await send(config, {
    to,
    subject: 'Reset your Lift-Off password',
    text,
    html,
  });
}

/** Used by the "Send test email" button in Settings. */
export async function sendTestEmail(config: MailConfig, to: string): Promise<void> {
  await send(config, {
    to,
    subject: 'Lift-Off SMTP test',
    text: 'Your Lift-Off SMTP settings are working.',
    html: '<p>Your Lift-Off SMTP settings are working.</p>',
  });
}

/** What the notification needs to know about the finished deployment. */
export interface DeploymentFinished {
  siteName: string;
  status: 'success' | 'failed' | 'cancelled';
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  triggeredBy: string | null;
  error: string | null;
  durationMs: number | null;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'unknown';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Sent once a deployment reaches a terminal status, successful or not, so a
 * failure is noticed without watching the UI.
 */
export async function sendDeploymentFinishedEmail(
  config: MailConfig,
  deployment: DeploymentFinished,
): Promise<void> {
  const ok = deployment.status === 'success';
  const shortSha = deployment.commitSha?.slice(0, 7) ?? '—';
  const branch = deployment.branch ?? '—';
  const who = deployment.triggeredBy ?? 'someone';
  const subject = `[Lift-Off] ${ok ? 'Deployed' : 'Failed'}: ${deployment.siteName}`;

  const text = [
    `${ok ? 'Deployment succeeded' : 'Deployment failed'} — ${deployment.siteName}`,
    '',
    `Status  : ${deployment.status}`,
    `Branch  : ${branch}`,
    `Commit  : ${shortSha}${deployment.commitMessage ? ` — ${deployment.commitMessage}` : ''}`,
    `Started by: ${who}`,
    `Duration: ${formatDuration(deployment.durationMs)}`,
    deployment.error ? `Error   : ${deployment.error}` : '',
    '',
    config.publicUrl ? `${config.publicUrl}/deployments` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const html = `
    <div style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; line-height: 1.5;">
      <p style="font-size:16px;">
        <strong>${ok ? 'Deployment succeeded' : 'Deployment failed'}</strong>
        &mdash; ${escapeHtml(deployment.siteName)}
      </p>
      <table cellpadding="4" style="font-size:14px;">
        <tr><td><strong>Status</strong></td><td>${escapeHtml(deployment.status)}</td></tr>
        <tr><td><strong>Branch</strong></td><td class="mono">${escapeHtml(branch)}</td></tr>
        <tr><td><strong>Commit</strong></td><td class="mono">${escapeHtml(shortSha)}${
          deployment.commitMessage
            ? ` — ${escapeHtml(deployment.commitMessage)}`
            : ''
        }</td></tr>
        <tr><td><strong>Started by</strong></td><td>${escapeHtml(who)}</td></tr>
        <tr><td><strong>Duration</strong></td><td>${escapeHtml(formatDuration(deployment.durationMs))}</td></tr>
        ${
          deployment.error
            ? `<tr><td><strong>Error</strong></td><td>${escapeHtml(deployment.error)}</td></tr>`
            : ''
        }
      </table>
      ${
        config.publicUrl
          ? `<p><a href="${escapeHtml(config.publicUrl)}/deployments">View deployments</a></p>`
          : ''
      }
    </div>
  `.trim();

  await send(config, { to: config.notifyEmail, subject, text, html });
}
