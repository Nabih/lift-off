import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as auth from '../src/auth.js';
import * as store from '../src/store.js';

async function main() {
  if (!auth.needsSetup()) {
    console.error(
      'An owner account already exists. This command only seeds the first account.',
    );
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const username = (await rl.question('Username (min 3 chars): ')).trim();
    const password = await rl.question('Password (min 10 chars): ');
    const confirm = await rl.question('Confirm password: ');
    const emailRaw = (await rl.question('Email (optional, for password resets): ')).trim();

    if (password !== confirm) {
      console.error('The two passwords do not match.');
      process.exit(1);
    }

    if (username.length < 3) {
      console.error('Username is too short.');
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
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
