/**
 * @file Atomic file writes
 * @description Write-to-temp-then-rename pattern to prevent corruption on crash.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export function atomicWriteFileSync(filePath: string, data: string, mode?: number): void {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpFile, data, 'utf-8');
    if (mode !== undefined) {
      try { fs.chmodSync(tmpFile, mode); } catch { /* Windows */ }
    }
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}
