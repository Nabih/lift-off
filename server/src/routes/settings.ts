import { Router } from 'express';
import { z } from 'zod';
import { firstIssue, requireUser } from '../guards.js';
import {
  getMailConfig,
  mailSettingsForUI,
  saveMailSettings,
  sendTestEmail,
} from '../mail.js';

export const settingsRouter = Router();

/** Accepts an absolute http(s) URL, or an empty string to disable email. */
const optionalBaseUrl = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => value === '' || /^https?:\/\/[^\s]+$/i.test(value),
    'Enter a URL starting with http:// or https://',
  );

const mailSchema = z.object({
  publicUrl: optionalBaseUrl,
  host: z.string().trim().max(255).default(''),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().trim().max(255).default(''),
  /** Blank means "keep the stored password"; absent means the same. */
  pass: z.string().max(500).optional(),
  from: z.string().trim().max(320).default(''),
  /** Comma-separated recipients notified when a deployment finishes. */
  notifyEmail: z.string().trim().max(640).optional(),
});

settingsRouter.get('/mail', (_req, res) => {
  res.json(mailSettingsForUI());
});

settingsRouter.put('/mail', (req, res) => {
  const parsed = mailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  saveMailSettings(parsed.data);
  res.json(mailSettingsForUI());
});

const testSchema = z.object({
  to: z.string().trim().max(320).optional(),
});

/** Sends a message using the saved settings, so the admin can verify them. */
settingsRouter.post('/mail/test', async (req, res, next) => {
  try {
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const config = getMailConfig();
    if (!config) {
      res.status(400).json({
        error:
          'Email is not fully configured yet. Fill in the public URL, SMTP host, and from address.',
      });
      return;
    }

    const recipient =
      parsed.data.to?.trim() ||
      requireUser(req).email ||
      extractAddress(config.from);
    if (!recipient) {
      res.status(400).json({ error: 'No recipient address available for the test.' });
      return;
    }

    await sendTestEmail(config, recipient);
    res.json({ ok: true, to: recipient });
  } catch (error) {
    next(error);
  }
});

/** Pulls the address out of a header like `Lift-Off <noreply@example.com>`. */
function extractAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim();
}
