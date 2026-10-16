import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from './process.js';
import { KEYS_DIR, ensureDirs } from './config.js';

export interface SshKeypair {
  privateKey: string;
  publicKey: string;
}

/**
 * Generates an ed25519 keypair with ssh-keygen. The comment becomes the key's
 * label on GitHub, so we tag it with the site name for readability.
 */
export async function generateSshKeypair(comment: string): Promise<SshKeypair> {
  ensureDirs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-key-'));
  const keyPath = path.join(dir, 'id_ed25519');

  try {
    await capture(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath],
      { cwd: dir },
    );
    const privateKey = fs.readFileSync(keyPath, 'utf8');
    const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
    return { privateKey, publicKey };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Derives the public key for a user-supplied private key, so an admin can
 * validate and save a site using their own already-generated key. Returns the
 * public key OpenSSH form; throws if the value is not a usable private key.
 */
export async function deriveSshPublicKey(privateKey: string): Promise<string> {
  ensureDirs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-key-'));
  const keyPath = path.join(dir, 'id');

  try {
    fs.writeFileSync(keyPath, `${privateKey.trim()}\n`, { mode: 0o600 });
    const publicKey = (
      await capture('ssh-keygen', ['-y', '-f', keyPath], { cwd: dir })
    ).trim();
    if (!publicKey) throw new Error('Could not derive a public key.');
    return publicKey;
  } catch {
    throw new Error('The pasted value is not a valid SSH private key.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** GitHub shows the deploy key form; strip the trailing comment for clarity. */
export function publicKeyFingerprint(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : publicKey.trim();
}
