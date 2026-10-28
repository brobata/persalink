#!/usr/bin/env node
/**
 * @file set-password.mjs
 * @description Set (or reset) the PersaLink password from a terminal on the
 *   server itself. Prompts twice without echo, applies the same strength rules
 *   as the app, writes the scrypt hash to ~/.persalink/config.json (+ .bak).
 *   Existing device logins are NOT revoked. `--public` sets a separate password
 *   for term.brobata.com only (safe to let a work browser save: it never
 *   unlocks the home devices, and that door still needs your phone).
 *   `--public --remove` goes back to the main password there. Restart afterwards:
 *   `pm2 restart persalink`. Needs a built server (apps/server/dist).
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as readline from 'node:readline';

const require = createRequire(import.meta.url);
const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../apps/server/dist/apps/server/src');
const { hashPassword, validatePassword, verifyPassword } = require(`${dist}/auth.js`);
const { loadConfig, saveConfig } = require(`${dist}/config.js`);

if (!process.stdin.isTTY) {
  console.error('Run this in an interactive terminal (it reads the password without echo).');
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.startsWith(prompt)) rl.output.write(prompt); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const isPublic = process.argv.includes('--public');
if (process.argv.includes('--remove') && !isPublic) {
  console.error('--remove only works with --public. Nothing changed.');
  process.exit(1);
}
if (isPublic) {
  const config = loadConfig();
  if (!config.publicListener) { console.error('The public door is not set up. Nothing changed.'); process.exit(1); }
  if (process.argv.includes('--remove')) {
    delete config.publicListener.passwordHash;
    saveConfig(config);
    console.log('term.brobata.com uses the main password again. Now run:  pm2 restart persalink');
    process.exit(0);
  }
}

const first = await ask(isPublic ? 'New term.brobata.com password: ' : 'New PersaLink password: ');
const problem = validatePassword(first);
if (problem) { console.error(problem); process.exit(1); }
if ((await ask('Type it again: ')) !== first) { console.error('Passwords did not match. Nothing changed.'); process.exit(1); }

const config = loadConfig();
if (isPublic) {
  if (config.passwordHash && await verifyPassword(first, config.passwordHash)) {
    console.error('That is your main password. Pick a different one for the work laptop. Nothing changed.');
    process.exit(1);
  }
  config.publicListener.passwordHash = await hashPassword(first);
} else {
  const doorHash = config.publicListener?.passwordHash;
  if (doorHash && await verifyPassword(first, doorHash)) {
    console.error('That is your term.brobata.com password. Pick a different one. Nothing changed.');
    process.exit(1);
  }
  config.passwordHash = await hashPassword(first);
}
saveConfig(config);
console.log('Password saved. Now run:  pm2 restart persalink');
console.log(isPublic
  ? '(Only term.brobata.com uses it; your main password stops working there.)'
  : '(Your signed-in devices stay signed in.)');
