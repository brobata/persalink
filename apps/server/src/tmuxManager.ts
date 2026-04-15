/**
 * @file TmuxManager — The Session Engine
 * @description All tmux interaction goes through this module. Provides a clean API
 *   for listing, creating, attaching, killing, and querying tmux sessions.
 *   The data plane uses a PTY running `tmux attach` to relay I/O to clients.
 *   The control plane uses `child_process.execFile` (safe, no shell injection).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as pty from 'node-pty';
import type { SessionInfo, TmuxWindowInfo, Profile } from '@persalink/shared/protocol';

const execFileAsync = promisify(execFile);

const TMUX_BIN = 'tmux';
const SESSION_PREFIX = 'pl-';

// ============================================================================
// Control Plane — tmux CLI wrapper (uses execFile, not exec — no shell injection)
// ============================================================================

async function tmux(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(TMUX_BIN, args, { timeout: 10_000 });
    return stdout.trim();
  } catch (err: any) {
    // tmux exits 1 when no sessions exist — that's not an error
    if (err.code === 1 && args[0] === 'list-sessions') return '';
    throw err;
  }
}

function parseSessionLine(line: string): { name: string; windows: number; created: number; attached: boolean } | null {
  // Uses | separator to avoid collision with colons in tmux session names
  const parts = line.split('|');
  if (parts.length < 4) return null;
  return {
    name: parts[0],
    windows: parseInt(parts[1], 10) || 1,
    created: parseInt(parts[2], 10) || 0,
    attached: parts[3] === '1',
  };
}

function parseWindowLine(line: string): TmuxWindowInfo | null {
  // Uses | separator to avoid collision with colons in window names
  const parts = line.split('|');
  if (parts.length < 4) return null;
  return {
    index: parseInt(parts[0], 10),
    name: parts[1],
    active: parts[2] === '1',
    paneCount: parseInt(parts[3], 10) || 1,
  };
}

// ============================================================================
// TmuxManager
// ============================================================================

export interface TmuxSessionBridge {
  ptyProcess: pty.IPty;
  sessionName: string;
  profileId?: string;
  onData: (data: string) => void;
  onExit: () => void;
  /** Set by detachClient to suppress session.ended on intentional detach */
  intentionalDetach?: boolean;
}

export class TmuxManager {
  private tmuxVersion: string = 'unknown';
  /** Custom display names set by clients (sessionId → displayName) */
  private customNames = new Map<string, string>();

  async init(): Promise<void> {
    try {
      const version = await tmux('-V');
      this.tmuxVersion = version;
      console.log(`[PersaLink] Tmux detected: ${version}`);
    } catch {
      throw new Error('tmux is not installed or not in PATH');
    }
  }

  getVersion(): string {
    return this.tmuxVersion;
  }

  /** List all PersaLink-managed tmux sessions */
  async listSessions(profileMap?: Map<string, Profile>): Promise<SessionInfo[]> {
    const raw = await tmux('list-sessions', '-F', '#{session_name}|#{session_windows}|#{session_created}|#{session_attached}');
    if (!raw) return [];

    const sessions: SessionInfo[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const parsed = parseSessionLine(line);
      if (!parsed) continue;

      // Only show PersaLink-managed sessions (prefixed with pl-)
      if (!parsed.name.startsWith(SESSION_PREFIX)) continue;

      const profileId = this.extractProfileId(parsed.name);
      const profile = profileId && profileMap ? profileMap.get(profileId) : undefined;

      // Fetch windows for this session
      const windows = await this.listWindows(parsed.name);

      // Get idle time
      let idleSeconds: number | undefined;
      try {
        const idle = await tmux('display-message', '-t', parsed.name, '-p', '#{session_activity}');
        if (idle) {
          idleSeconds = Math.floor(Date.now() / 1000) - parseInt(idle, 10);
        }
      } catch { /* ignore */ }

      sessions.push({
        id: parsed.name,
        name: this.customNames.get(parsed.name) || profile?.name || parsed.name.replace(SESSION_PREFIX, ''),
        profileId,
        profileName: profile?.name,
        profileColor: profile?.color,
        profileIcon: profile?.icon,
        windows,
        createdAt: parsed.created * 1000,
        attached: parsed.attached,
        idleSeconds,
      });
    }

    return sessions;
  }

  /** List windows within a tmux session */
  async listWindows(sessionName: string): Promise<TmuxWindowInfo[]> {
    try {
      const raw = await tmux('list-windows', '-t', sessionName, '-F',
        '#{window_index}|#{window_name}|#{window_active}|#{window_panes}');
      if (!raw) return [];

      const windows: TmuxWindowInfo[] = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        const parsed = parseWindowLine(line);
        if (parsed) windows.push(parsed);
      }
      return windows;
    } catch {
      return [];
    }
  }

  /** Create a new tmux session from a profile (or bare) */
  async createSession(profile?: Profile, cols: number = 120, rows: number = 40): Promise<string> {
    const sessionName = profile
      ? `${SESSION_PREFIX}${profile.id}`
      : `${SESSION_PREFIX}${Date.now()}`;

    // Check if session already exists
    const existing = await this.sessionExists(sessionName);
    if (existing) {
      return sessionName; // Reuse existing
    }

    const args = [
      'new-session', '-d',
      '-s', sessionName,
      '-x', String(Math.max(10, Math.min(500, cols))),
      '-y', String(Math.max(2, Math.min(200, rows))),
    ];

    const cwd = profile?.cwd
      ? profile.cwd.replace(/^~/, process.env.HOME || '/home')
      : process.env.HOME;
    if (cwd) args.push('-c', cwd);

    await tmux(...args);

    // Set environment variables via tmux set-environment (safe — no shell)
    if (profile?.env) {
      for (const [key, value] of Object.entries(profile.env)) {
        await tmux('set-environment', '-t', sessionName, key, value);
      }
    }

    // Run startup command via tmux send-keys (delivered to the tmux pane, not a shell exec)
    if (profile?.command) {
      await tmux('send-keys', '-t', sessionName, profile.command, 'Enter');
    }

    return sessionName;
  }

  /** Check if a tmux session exists */
  async sessionExists(sessionName: string): Promise<boolean> {
    try {
      await tmux('has-session', '-t', sessionName);
      return true;
    } catch {
      return false;
    }
  }

  /** Rename a session's display name */
  async renameSession(sessionName: string, newName: string): Promise<void> {
    if (!sessionName.startsWith(SESSION_PREFIX)) {
      throw new Error('Cannot rename non-PersaLink sessions');
    }
    const trimmed = newName.trim();
    if (!trimmed) {
      this.customNames.delete(sessionName);
    } else {
      this.customNames.set(sessionName, trimmed);
    }
  }

  /** Kill a tmux session */
  async killSession(sessionName: string): Promise<void> {
    if (!sessionName.startsWith(SESSION_PREFIX)) {
      throw new Error('Cannot kill non-PersaLink sessions');
    }
    await tmux('kill-session', '-t', sessionName);
    this.customNames.delete(sessionName);
  }

  /** Capture scrollback from the current pane */
  async captureScrollback(sessionName: string, lines: number = 2000): Promise<string> {
    try {
      const output = await tmux('capture-pane', '-t', sessionName, '-p', '-S', `-${lines}`);
      return output;
    } catch {
      return '';
    }
  }

  /** Resize a tmux session — sets aggressive-resize so our PTY size wins */
  async resizeSession(sessionName: string): Promise<void> {
    try {
      await tmux('set-option', '-t', sessionName, 'aggressive-resize', 'on');
    } catch { /* ignore */ }
  }

  /** Select a window within the attached session */
  async selectWindow(sessionName: string, windowIndex: number): Promise<void> {
    await tmux('select-window', '-t', `${sessionName}:${windowIndex}`);
  }

  /** Create a new window in the session */
  async createWindow(sessionName: string, name?: string): Promise<void> {
    const args = ['new-window', '-t', sessionName];
    if (name) args.push('-n', name);
    await tmux(...args);
  }

  /** Rename a window within a session */
  async renameWindow(sessionName: string, windowIndex: number, name: string): Promise<void> {
    await tmux('rename-window', '-t', `${sessionName}:${windowIndex}`, name);
  }

  /** Kill a window within a session */
  async killWindow(sessionName: string, windowIndex: number): Promise<void> {
    await tmux('kill-window', '-t', `${sessionName}:${windowIndex}`);
  }

  /**
   * Create a PTY bridge to an existing tmux session.
   * This spawns `tmux attach -t <session>` inside a PTY, giving us
   * full terminal I/O that we relay over WebSocket to the client.
   */
  attachBridge(
    sessionName: string,
    cols: number,
    rows: number,
    onData: (data: string) => void,
    onExit: () => void,
  ): TmuxSessionBridge {
    const ptyProcess = pty.spawn(TMUX_BIN, ['attach-session', '-t', sessionName], {
      name: 'xterm-256color',
      cols: Math.max(10, Math.min(500, cols)),
      rows: Math.max(2, Math.min(200, rows)),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    ptyProcess.onData(onData);
    ptyProcess.onExit(onExit);

    return {
      ptyProcess,
      sessionName,
      onData,
      onExit,
    };
  }

  /**
   * Run a quick action command. These are user-defined commands from server-side
   * profiles (trusted input — not client-supplied). Uses execFile with bash -c
   * because profile commands may use shell features (pipes, redirects).
   */
  async runAction(command: string, cwd?: string): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve) => {
      const cwdResolved = cwd?.replace(/^~/, process.env.HOME || '/home');
      execFile('bash', ['-c', command], {
        timeout: 30_000,
        cwd: cwdResolved || process.env.HOME,
        env: process.env,
      }, (err, stdout, stderr) => {
        resolve({
          output: stdout + (stderr ? '\n' + stderr : ''),
          exitCode: err ? (err as any).code || 1 : 0,
        });
      });
    });
  }

  /** Run a health check command (trusted, from server-side profile config) */
  async runHealthCheck(command: string, cwd?: string): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve) => {
      const cwdResolved = cwd?.replace(/^~/, process.env.HOME || '/home');
      execFile('bash', ['-c', command], {
        timeout: 10_000,
        cwd: cwdResolved || process.env.HOME,
        env: process.env,
      }, (err, stdout, stderr) => {
        resolve({
          output: (stdout + (stderr ? '\n' + stderr : '')).slice(0, 4096),
          exitCode: err ? (err as any).code || 1 : 0,
        });
      });
    });
  }

  /** Extract profile ID from tmux session name */
  private extractProfileId(sessionName: string): string | undefined {
    if (!sessionName.startsWith(SESSION_PREFIX)) return undefined;
    const id = sessionName.slice(SESSION_PREFIX.length);
    // If it's a timestamp (bare session), no profile
    if (/^\d+$/.test(id)) return undefined;
    return id;
  }
}
