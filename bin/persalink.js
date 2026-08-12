#!/usr/bin/env node
/**
 * @file persalink CLI entrypoint
 * @description npm-global launcher (`npm i -g persalink` → `persalink`).
 *   Runs the bundled server from the package root so relative paths to the
 *   prebuilt client dist resolve. Shipped inside the staged npm package by
 *   scripts/release/stage.sh.
 */
const path = require('path');
const packageRoot = path.resolve(__dirname, '..');
process.chdir(packageRoot);
require(path.join(packageRoot, 'apps/server/dist/apps/server/src/main/index.js'));
