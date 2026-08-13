/**
 * @file Session output logs
 * @description Opt-in (per profile) capture of session output via
 *   `tmux pipe-pane` into ~/.persalink/logs/, one file per session per day.
 *   Logs never leave this server; retention is capped by age and total size.
 *   Raw output includes ANSI escapes — read() strips them for display.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from './config';

const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const MAX_AGE_DAYS = 14;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_READ_BYTES = 512 * 1024;

// Strip ANSI CSI/OSC sequences, charset selects, and bare carriage returns so
// the raw PTY stream reads as plain text. Progress-bar redraw spam survives as
// repeated lines — acceptable for a grep-oriented log view.
const ANSI_RX = /\x1b\[[0-9;?]*[a-zA-Z@]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0AB]|\x1b[=>]|\r/g;

export interface LogInfo {
  name: string;
  size: number;
  mtime: number;
}

export class LogManager {
  ensureDir(): void {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  }

  /** Log file for a session, split per day so retention stays simple. */
  fileFor(sessionName: string): string {
    const d = new Date();
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    // Session names are validated pl-* tmux names, but never trust a path join.
    const safe = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(LOGS_DIR, `${safe}--${day}.log`);
  }

  list(): LogInfo[] {
    this.ensureDir();
    return fs.readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((name) => {
        const st = fs.statSync(path.join(LOGS_DIR, name));
        return { name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  /** Read the tail of a log, ANSI-stripped. `name` must be an exact entry
   *  from list() — basename equality, no paths. */
  read(name: string): { data: string; truncated: boolean } | null {
    if (name !== path.basename(name) || !name.endsWith('.log')) return null;
    const file = path.join(LOGS_DIR, name);
    if (!fs.existsSync(file)) return null;
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - MAX_READ_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return { data: buf.toString('utf-8').replace(ANSI_RX, ''), truncated: start > 0 };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Drop logs past the age cap, then oldest-first past the size cap. */
  prune(): void {
    try {
      const logs = this.list();
      const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
      let total = 0;
      const survivors: LogInfo[] = [];
      for (const log of logs) {
        if (log.mtime < cutoff) {
          fs.unlinkSync(path.join(LOGS_DIR, log.name));
        } else {
          survivors.push(log);
          total += log.size;
        }
      }
      // survivors are newest-first; trim from the back (oldest) when over cap.
      for (let i = survivors.length - 1; i >= 0 && total > MAX_TOTAL_BYTES; i--) {
        fs.unlinkSync(path.join(LOGS_DIR, survivors[i].name));
        total -= survivors[i].size;
      }
    } catch (err) {
      console.warn('[PersaLink] Log prune failed:', err instanceof Error ? err.message : err);
    }
  }
}
