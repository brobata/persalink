#!/usr/bin/env node
/**
 * @file set-totp.mjs
 * @description Turn on (or replace) the authenticator-app code for the public
 *   door (term.brobata.com). Prints a QR code to scan with Google Authenticator,
 *   asks for one code to prove it took, then saves the secret to
 *   publicListener.totpSecret in ~/.persalink/config.json (+ .bak).
 *   `--remove` turns it off. Restart afterwards: `pm2 restart persalink`.
 *   Needs a built server (apps/server/dist).
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as readline from 'node:readline';

const require = createRequire(import.meta.url);
const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../apps/server/dist/apps/server/src');
const { generateSecret, verifyCode, otpauthUri } = require(`${dist}/totp.js`);
const { loadConfig, saveConfig } = require(`${dist}/config.js`);
const QRCode = require('qrcode');

if (!process.stdin.isTTY) {
  console.error('Run this in an interactive terminal (it shows a QR code and asks for a code).');
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

const config = loadConfig();
if (!config.publicListener) {
  console.error('The public door is not set up in ~/.persalink/config.json. Nothing changed.');
  process.exit(1);
}

if (process.argv.includes('--remove')) {
  delete config.publicListener.totpSecret;
  saveConfig(config);
  console.log('Authenticator code turned off. Now run:  pm2 restart persalink');
  process.exit(0);
}

if (config.publicListener.totpSecret) {
  const yes = await ask('An authenticator is already set up. Replace it? The old code stops working. [y/N] ');
  if (!/^y(es)?$/i.test(yes)) { console.log('Nothing changed.'); process.exit(0); }
}

const secret = generateSecret();
const uri = otpauthUri(secret, 'Terminal', 'SpokeRemote');
console.log('\nScan this with Google Authenticator (+ → Scan a QR code):\n');
console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
console.log('Or type this setup key instead:  ' + secret.match(/.{1,4}/g).join(' '));
console.log('(Account: SpokeRemote: Terminal, time-based)\n');

for (let tries = 0; tries < 3; tries++) {
  const code = (await ask('Type the 6-digit code it shows: ')).replace(/\s+/g, '');
  if (verifyCode(secret, code) !== null) {
    config.publicListener.totpSecret = secret;
    saveConfig(config);
    console.log('\nSaved. Now run:  pm2 restart persalink');
    console.log('From then on term.brobata.com asks for the password plus a code (or a phone approval).');
    process.exit(0);
  }
  console.log('That code did not match. Check the phone clock is automatic, and try the next code.');
}
console.error('Nothing changed.');
process.exit(1);
