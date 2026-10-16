import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDirs } from './config.js';

let cachedMasterKey: Buffer | null = null;

/**
 * The master key encrypts secrets (SSH private keys) at rest.
 * Priority: LIFTOFF_SECRET_KEY env var, then data/secret.key (created on first
 * boot with 0600 permissions).
 */
function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  const fromEnv = process.env.LIFTOFF_SECRET_KEY;
  if (fromEnv) {
    const buf = /^[0-9a-fA-F]{64}$/.test(fromEnv)
      ? Buffer.from(fromEnv, 'hex')
      : Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        'LIFTOFF_SECRET_KEY must be exactly 32 bytes (64 hex chars or base64-encoded).',
      );
    }
    cachedMasterKey = buf;
    return buf;
  }

  ensureDirs();
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(keyFile)) {
    cachedMasterKey = fs.readFileSync(keyFile);
    return cachedMasterKey;
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  cachedMasterKey = generated;
  return generated;
}

/** AES-256-GCM. Returns `v1:<iv>:<tag>:<ciphertext>`, all base64. */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed ciphertext');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    masterKey(),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** scrypt password hashing, no native deps. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split(':');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}
