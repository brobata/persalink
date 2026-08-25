/**
 * @file ProfileManager
 * @description CRUD for project profiles stored in ~/.persalink/profiles.json.
 *   Includes auto-discovery of ~/projects directories.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Profile } from '@persalink/shared/protocol';
import { validateProfileShape } from '@persalink/shared/protocol';
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

/** Validate a profile via the shared zod schema. Single source of truth. */
export function validateProfile(profile: Profile): string | null {
  return validateProfileShape(profile);
}

// ============================================================================
// ProfileManager
// ============================================================================

export class ProfileManager {
  private profiles: Map<string, Profile> = new Map();
  /** Hash of the profiles.json content we last read or wrote — lets the file
   *  watcher tell an external edit apart from the echo of our own save(). */
  private lastKnownHash = '';
  private watcher: fs.FSWatcher | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;
  private changeListeners: Array<() => void> = [];

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

  /**
   * Register a callback fired when profiles.json changes underneath us
   * (a hand-edit, a script, another tool) and the reload succeeds.
   */
  onExternalChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  /**
   * Watch profiles.json for out-of-band edits.
   *
   * Without this the constructor's one-shot load() is the only read that ever
   * happens: a file edited while the server runs stays invisible until a
   * restart, and — worse — the next save() writes the stale in-memory list
   * straight over the edit.
   *
   * Watches the DIRECTORY, not the file: atomicWriteFileSync() replaces
   * profiles.json via rename, and a file-level watch would keep following the
   * replaced inode and go permanently deaf after the first write.
   */
  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(CONFIG_DIR, (_event, filename) => {
        if (filename === path.basename(PROFILES_FILE)) this.scheduleReload();
      });
      this.watcher.on('error', (err) => {
        console.error('[profiles] watcher error:', (err as Error).message);
        this.stopWatching();
      });
    } catch (err) {
      // Not fatal — the server just falls back to load-at-boot behaviour.
      console.error(`[profiles] could not watch ${CONFIG_DIR}:`, (err as Error).message);
    }
  }

  stopWatching(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Coalesce the burst of events a single logical edit produces. */
  private scheduleReload(): void {
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      this.reloadIfChanged();
    }, 200);
  }

  /**
   * Non-destructive counterpart to load(). Where load() throws and renames a
   * corrupt file aside (correct at boot), this one keeps the current profiles
   * and waits for the next write — a watcher must never destroy state on what
   * may just be a half-written file caught mid-edit.
   */
  private reloadIfChanged(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(PROFILES_FILE, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[profiles] reload: read failed:', (err as Error).message);
      }
      return;
    }

    const hash = hashContent(raw);
    if (hash === this.lastKnownHash) return; // our own save, or a no-op touch

    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      console.error('[profiles] reload: file is not valid JSON yet — keeping current profiles');
      return;
    }
    if (!Array.isArray(list)) {
      console.error('[profiles] reload: expected an array — keeping current profiles');
      return;
    }

    const next = new Map<string, Profile>();
    for (const profile of list as Profile[]) {
      if (profile && typeof profile.id === 'string' && profile.id) next.set(profile.id, profile);
    }
    if (next.size === 0) {
      console.error('[profiles] reload: no usable profiles — keeping current profiles');
      return;
    }
    // Mirror the constructor's guarantee that 'default' always exists, but in
    // memory only — writing here would race the editor that just saved.
    if (!next.has('default')) next.set('default', DEFAULT_PROFILE);

    this.profiles = next;
    this.lastKnownHash = hash;

    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[profiles] reload listener failed:', (err as Error).message);
      }
    }
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
    this.lastKnownHash = hashContent(raw);
  }

  private save(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const list = Array.from(this.profiles.values());
    const json = JSON.stringify(list, null, 2);
    // Record before writing: the watcher fires on our own rename too, and
    // without this baseline every UI save would echo back as an "external"
    // change and trigger a redundant reload + broadcast.
    this.lastKnownHash = hashContent(json);
    atomicWriteFileSync(PROFILES_FILE, json, 0o600);
  }
}

function hashContent(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
