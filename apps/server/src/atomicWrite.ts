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
    // Write + fsync the temp file's data to disk BEFORE the rename, so a power
    // loss right after the rename can't leave a zero-length or partial file
    // where the durable old data used to be — on some filesystems the rename
    // can otherwise be journaled ahead of the data blocks.
    const fd = fs.openSync(tmpFile, 'w', mode ?? 0o600);
    try {
      fs.writeFileSync(fd, data, 'utf-8');
      try { fs.fsyncSync(fd); } catch { /* fsync unsupported on this FS/OS — best effort */ }
    } finally {
      fs.closeSync(fd);
    }
    if (mode !== undefined) {
      try { fs.chmodSync(tmpFile, mode); } catch { /* Windows */ }
    }
    fs.renameSync(tmpFile, filePath);
    // fsync the directory so the rename entry itself is durable, not just data.
    try {
      const dfd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dfd); } catch { /* directory fsync unsupported */ }
      finally { fs.closeSync(dfd); }
    } catch { /* best effort */ }
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}
