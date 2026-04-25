/**
 * @file ProfileManager
 * @description CRUD for project profiles stored in ~/.persalink/profiles.json.
 *   Includes auto-discovery of ~/projects directories.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Profile } from '@persalink/shared/protocol';
import { atomicWriteFileSync } from './atomicWrite';
import { CONFIG_DIR } from './config';

const execFileAsync = promisify(execFile);

const PROFILES_FILE = path.join(CONFIG_DIR, 'profiles.json');

const DEFAULT_PROFILE: Profile = {
  id: 'default',
  name: 'Default',
  icon: '\uD83D\uDCBB',
  group: 'Quick',
};

const CLAUDE_PROFILE: Profile = {
  id: 'claude',
  name: 'Claude',
  icon: '\uD83E\uDDE0',
  color: '#eab308',
  command: 'claude',
  group: 'Quick',
  pinned: true,
};

// ============================================================================
// Validation
// ============================================================================

const MAX_PROFILE_NAME_LENGTH = 100;
const MAX_CWD_LENGTH = 512;
const MAX_COMMAND_LENGTH = 1000;
const MAX_ENV_ENTRIES = 50;
const MAX_ENV_KEY_LENGTH = 128;
const MAX_ENV_VALUE_LENGTH = 4096;
const COLOR_HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_ACTIONS = 20;

export function validateProfile(profile: Profile): string | null {
  if (!profile.id || typeof profile.id !== 'string') return 'Profile ID is required';
  if (profile.id.length > 100 || !PROFILE_ID_PATTERN.test(profile.id)) {
    return 'Profile ID must be alphanumeric with hyphens/underscores';
  }
  if (!profile.name || typeof profile.name !== 'string') return 'Profile name is required';
  if (profile.name.length > MAX_PROFILE_NAME_LENGTH) {
    return `Profile name must be ${MAX_PROFILE_NAME_LENGTH} characters or fewer`;
  }
  if (profile.shell !== undefined) {
    if (typeof profile.shell !== 'string' || profile.shell.length > 256) {
      return 'Invalid shell path';
    }
    if (/[;&|`$]/.test(profile.shell)) {
      return 'Shell path contains invalid characters';
    }
    // Reject leading dash — tmux/bash would interpret as a flag.
    if (profile.shell.startsWith('-')) return 'Shell path cannot start with "-"';
  }
  if (profile.cwd !== undefined) {
    if (typeof profile.cwd !== 'string' || profile.cwd.length > MAX_CWD_LENGTH) {
      return 'Invalid working directory';
    }
    // Reject leading dash — tmux uses `-c <cwd>` and would parse a leading
    // dash as a separate flag (argument injection).
    if (profile.cwd.startsWith('-')) return 'Working directory cannot start with "-"';
    // Reject newlines/control chars that could escape into tmux command lines.
    if (/[\x00-\x1f]/.test(profile.cwd)) return 'Working directory contains control characters';
  }
  if (profile.command !== undefined) {
    if (typeof profile.command !== 'string' || profile.command.length > MAX_COMMAND_LENGTH) {
      return `Command must be ${MAX_COMMAND_LENGTH} characters or fewer`;
    }
    // Reject embedded newlines/CRs — `command` is fed straight into
    // `tmux send-keys ... Enter` and a newline would chain commands silently.
    if (/[\r\n]/.test(profile.command)) return 'Command cannot contain newlines';
  }
  if (profile.env !== undefined) {
    if (typeof profile.env !== 'object' || profile.env === null) return 'Invalid env';
    const entries = Object.entries(profile.env);
    if (entries.length > MAX_ENV_ENTRIES) return `Max ${MAX_ENV_ENTRIES} environment variables`;
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.length > MAX_ENV_KEY_LENGTH) return 'Invalid env key';
      // Env keys are typically [A-Z_][A-Z0-9_]*; reject anything that would
      // need quoting or could be misread as a flag.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `Invalid env key: ${key}`;
      if (typeof value !== 'string' || value.length > MAX_ENV_VALUE_LENGTH) return 'Invalid env value';
      if (/[\x00\r\n]/.test(value)) return 'Env value contains control characters';
    }
  }
  if (profile.color !== undefined && profile.color !== null) {
    if (typeof profile.color !== 'string' || !COLOR_HEX_PATTERN.test(profile.color)) {
      return 'Color must be a hex color (e.g. #ff5500)';
    }
  }
  if (profile.actions !== undefined) {
    if (!Array.isArray(profile.actions)) return 'Actions must be an array';
    if (profile.actions.length > MAX_ACTIONS) return `Max ${MAX_ACTIONS} quick actions`;
    for (const action of profile.actions) {
      if (!action.id || !action.name || !action.command) {
        return 'Each action needs id, name, and command';
      }
    }
  }
  if (profile.group !== undefined) {
    if (typeof profile.group !== 'string' || profile.group.length > 50) {
      return 'Group name must be 50 characters or fewer';
    }
  }
  return null;
}

// ============================================================================
// ProfileManager
// ============================================================================

export class ProfileManager {
  private profiles: Map<string, Profile> = new Map();

  constructor() {
    const isFirstRun = !fs.existsSync(PROFILES_FILE);
    this.load();

    if (isFirstRun) {
      // First run: seed with default + claude profiles
      this.profiles.set('default', DEFAULT_PROFILE);
      this.profiles.set('claude', CLAUDE_PROFILE);
      this.save();
    } else if (!this.profiles.has('default')) {
      this.profiles.set('default', DEFAULT_PROFILE);
      this.save();
    }
  }

  list(): Profile[] {
    return Array.from(this.profiles.values());
  }

  get(id: string): Profile | null {
    return this.profiles.get(id) || null;
  }

  getMap(): Map<string, Profile> {
    return new Map(this.profiles);
  }

  upsert(profile: Profile): string | null {
    const error = validateProfile(profile);
    if (error) return error;

    if (profile.id === 'default') {
      const existing = this.profiles.get('default');
      if (existing) {
        profile.shell = existing.shell;
      }
    }

    this.profiles.set(profile.id, profile);
    this.save();
    return null;
  }

  reorder(profileIds: string[]): void {
    const reordered = new Map<string, Profile>();
    for (const id of profileIds) {
      const profile = this.profiles.get(id);
      if (profile) reordered.set(id, profile);
    }
    // Append any profiles not in the list (safety net)
    for (const [id, profile] of this.profiles) {
      if (!reordered.has(id)) reordered.set(id, profile);
    }
    this.profiles = reordered;
    this.save();
  }

  delete(id: string): boolean {
    if (id === 'default') return false;
    const deleted = this.profiles.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  /**
   * Auto-discover projects in ~/projects and generate profile suggestions.
   * Scans for git repos, detects project type, generates meaningful profiles.
   */
  async discover(): Promise<Profile[]> {
    const projectsDir = path.join(os.homedir(), 'projects');

    let entries: import('fs').Dirent[];
    try {
      entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const candidates = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        path: path.join(projectsDir, e.name),
        profileId: e.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      }))
      .filter(c => !this.profiles.has(c.profileId));

    // Run per-project detection in parallel — was sequential await in a for
    // loop, which blocks every client's WebSocket on a NAS-mounted dir.
    const results = await Promise.all(
      candidates.map(async (c) => {
        try {
          // Probe for .git first; skip non-repos.
          await fs.promises.access(path.join(c.path, '.git'));
        } catch { return null; }
        return this.detectProjectProfile(c.profileId, c.name, c.path);
      }),
    );

    return results.filter((p): p is Profile => p !== null);
  }

  private async detectProjectProfile(id: string, name: string, projectPath: string): Promise<Profile | null> {
    // Run all the sentinel-file probes in parallel.
    const [hasPackageJson, hasComposeYml, hasComposeProdYml] = await Promise.all([
      fs.promises.access(path.join(projectPath, 'package.json')).then(() => true, () => false),
      fs.promises.access(path.join(projectPath, 'docker-compose.yml')).then(() => true, () => false),
      fs.promises.access(path.join(projectPath, 'docker-compose.prod.yml')).then(() => true, () => false),
    ]);
    const hasDockerCompose = hasComposeYml || hasComposeProdYml;

    // Default: open Claude in the project directory
    const profile: Profile = {
      id,
      name: this.prettifyName(name),
      cwd: projectPath.replace(os.homedir(), '~'),
      command: `claude '/${id}'`,
      icon: this.inferIcon(name),
      color: this.generateColor(name),
      group: 'Discovered',
    };

    // Add relevant quick actions
    const actions = [];
    if (hasPackageJson) {
      actions.push({ id: 'dev', name: 'Dev Server', command: 'npm run dev' });
      actions.push({ id: 'build', name: 'Build', command: 'npm run build' });
    }
    if (hasDockerCompose) {
      actions.push({ id: 'docker-ps', name: 'Docker Status', command: 'docker compose ps' });
      actions.push({ id: 'docker-logs', name: 'Docker Logs', command: 'docker compose logs --tail=50' });
    }

    // Git actions for all
    actions.push({ id: 'git-status', name: 'Git Status', command: 'git status' });
    actions.push({ id: 'git-pull', name: 'Git Pull', command: 'git pull' });

    if (actions.length > 0) {
      profile.actions = actions;
    }

    return profile;
  }

  private inferIcon(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('api') || lower.includes('server') || lower.includes('backend')) return '\u2699\uFE0F';
    if (lower.includes('web') || lower.includes('site') || lower.includes('front')) return '\uD83C\uDF10';
    if (lower.includes('mail') || lower.includes('email')) return '\u2709\uFE0F';
    if (lower.includes('auth') || lower.includes('login')) return '\uD83D\uDD10';
    if (lower.includes('docker') || lower.includes('container')) return '\uD83D\uDC33';
    if (lower.includes('test') || lower.includes('spec')) return '\uD83E\uDDEA';
    if (lower.includes('doc') || lower.includes('wiki')) return '\uD83D\uDCDA';
    if (lower.includes('db') || lower.includes('database') || lower.includes('sql')) return '\uD83D\uDDC4\uFE0F';
    if (lower.includes('deploy') || lower.includes('ci') || lower.includes('pipeline')) return '\uD83D\uDE80';
    if (lower.includes('config') || lower.includes('setting')) return '\uD83D\uDD27';
    if (lower.includes('monitor') || lower.includes('log') || lower.includes('dash')) return '\uD83D\uDCCA';
    if (lower.includes('link') || lower.includes('connect')) return '\uD83D\uDD17';
    return '\uD83D\uDCC2';
  }

  private prettifyName(name: string): string {
    return name
      .replace(/-/g, ' ')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  private generateColor(name: string): string {
    // Simple hash-based color generation for consistency
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    // Convert HSL to hex (saturation 65%, lightness 55%)
    const h = hue / 360;
    const s = 0.65;
    const l = 0.55;
    const a2 = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h * 12) % 12;
      return l - a2 * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(PROFILES_FILE, 'utf-8');
    } catch (err) {
      // Legitimate first run — file doesn't exist yet.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Any other read error (EACCES, EISDIR, IO error) must NOT silently reset.
      // Returning here would let the next save() clobber the user's existing
      // profiles file. Throw so the server fails to start with a clear error.
      throw new Error(`Failed to read profiles at ${PROFILES_FILE}: ${(err as Error).message}`);
    }

    let list: Profile[];
    try {
      list = JSON.parse(raw);
    } catch (err) {
      // Corrupt JSON. Rename aside so the user can recover, then proceed empty.
      const aside = `${PROFILES_FILE}.corrupt-${Date.now()}`;
      try { fs.renameSync(PROFILES_FILE, aside); } catch { /* best-effort */ }
      throw new Error(`profiles.json was corrupt (saved aside as ${aside}): ${(err as Error).message}`);
    }

    this.profiles.clear();
    for (const profile of list) {
      this.profiles.set(profile.id, profile);
    }
  }

  private save(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const list = Array.from(this.profiles.values());
    atomicWriteFileSync(PROFILES_FILE, JSON.stringify(list, null, 2), 0o600);
  }
}
