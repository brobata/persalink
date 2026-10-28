#!/usr/bin/env node
/**
 * @file set-password.mjs
 * @description Set (or reset) the PersaLink password from a terminal on the
 *   server itself. Prompts twice without echo, applies the same strength rules
 *   as the app, writes the scrypt hash to ~/.persalink/config.json (+ .bak).
 *   Existing device logins are NOT revoked. Restart afterwards:
 *   `pm2 restart persalink`. Needs a built server (apps/server/dist).
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as readline from 'node:readline';

const require = createRequire(import.meta.url);
const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../apps/server/dist/apps/server/src');
const { hashPassword, validatePassword } = require(`${dist}/auth.js`);
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

const first = await ask('New PersaLink password: ');
const problem = validatePassword(first);
if (problem) { console.error(problem); process.exit(1); }
if ((await ask('Type it again: ')) !== first) { console.error('Passwords did not match. Nothing changed.'); process.exit(1); }

const config = loadConfig();
config.passwordHash = await hashPassword(first);
saveConfig(config);
console.log('Password saved. Now run:  pm2 restart persalink');
console.log('(Your signed-in devices stay signed in.)');
