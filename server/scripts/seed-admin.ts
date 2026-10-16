import { stdin as input, stdout as output } from 'node:process';
import * as auth from '../src/auth.js';
import * as store from '../src/store.js';

/** In piped (non-TTY) mode, read everything up front and split into lines. */
const pipedLines: string[] | null = input.isTTY
  ? null
  : await (async () => {
      let data = '';
      input.setEncoding('utf8');
      input.resume();
      await new Promise<void>((resolve) => {
        input.on('data', (c) => {
          data += typeof c === 'string' ? c : c.toString('utf8');
        });
        input.on('end', () => resolve());
      });
      return data.split(/\r?\n/);
    })();
let lineCursor = 0;

/** Read one line of typed input from a TTY (chars echoed according to `mask`). */
function readLineTty(masked: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    if (stdinIsTty()) input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\n' || ch === '\r') {
          finish(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.exit(130);
        }
        if (ch === '\u0004') {
          finish(buf);
          return;
        }
        if (ch === '\u007F' || ch === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        buf += ch;
        output.write(masked ? '*' : ch);
      }
    };
    const finish = (value: string) => {
      cleanup();
      output.write('\n');
      resolve(value);
    };
    const cleanup = () => {
      input.removeListener('data', onData);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
    };
    input.on('data', onData);
  });
}

function stdinIsTty() {
  return Boolean(input.isTTY);
}

async function readLine(masked: boolean): Promise<string> {
  if (pipedLines !== null) {
    return pipedLines[lineCursor++] ?? '';
  }
  return readLineTty(masked);
}

async function ask(prompt: string): Promise<string> {
  output.write(prompt);
  const value = await readLine(false);
  if (pipedLines !== null) output.write(value.trim() + '\n');
  return value.trim();
}

async function askSecret(prompt: string): Promise<string> {
  output.write(prompt);
  return await readLine(true);
}

async function main() {
  if (!auth.needsSetup()) {
    console.error(
      'An owner account already exists. This command only seeds the first account.',
    );
    process.exit(1);
  }

  const username = await ask('Username (min 3 chars): ');
  const password = await askSecret('Password (min 10 chars): ');
  const confirm = await askSecret('Confirm password: ');
  const emailRaw = await ask('Email (optional, for password resets): ');

  if (password !== confirm) {
    console.error('The two passwords do not match.');
    process.exit(1);
  }
  if (username.length < 3) {
    console.error('Username must be at least 3 characters.');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }

  const email = emailRaw ? emailRaw.toLowerCase() : null;
  if (email) {
    const clash = store.getUserByEmail(email);
    if (clash) {
      console.error('That email address is already in use.');
      process.exit(1);
    }
  }

  const row = auth.bootstrapOwner({ username, password, email });
  console.log(`Owner account "${row.username}" created (id ${row.id}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
