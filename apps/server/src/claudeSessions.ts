/**
 * @file Claude Code session lookup
 * @description Finds the Claude Code transcript behind a PersaLink tmux
 *   session, so the client can copy Claude's replies (and their links / code
 *   blocks) from the raw markdown instead of the hard-wrapped terminal.
 *
 *   Every running interactive Claude Code process keeps a status file at
 *   ~/.claude/sessions/<pid>.json that records its sessionId and the tmux
 *   pane it runs in ("pl-claude-4:@92.%92"). That gives an exact
 *   session → transcript mapping without hooks or process-tree guessing; the
 *   transcript itself lives at ~/.claude/projects/<slug>/<sessionId>.jsonl.
 *   These files are Claude Code internals, so every read is defensive and
 *   failure means "not available", never an exception.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTranscriptLines, lastReply, assistantTexts, extractCodeBlocks, type CodeBlock } from '@persalink/shared/claudeTranscript';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
/** Tail window read from the transcript. Big enough for many turns of text;
 *  transcripts themselves grow to tens of MB. */
const TAIL_BYTES = 4 * 1024 * 1024;
const SESSION_ID_RX = /^[0-9a-f-]{36}$/i;

interface StatusFile {
  pid?: unknown;
  sessionId?: unknown;
  tmux?: unknown;
  updatedAt?: unknown;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The Claude Code sessionId running in a tmux session, or null. When several
 * Claude processes share the session (multiple windows/panes), the one in
 * `activePaneId` wins, then the most recently updated.
 */
export function findClaudeSessionId(tmuxSession: string, activePaneId: string | null): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  const candidates: Array<{ sessionId: string; pane: string; updatedAt: number }> = [];
  for (const name of names) {
    let status: StatusFile;
    try {
      status = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf-8')) as StatusFile;
    } catch {
      continue;
    }
    if (typeof status.tmux !== 'string' || typeof status.sessionId !== 'string') continue;
    if (!SESSION_ID_RX.test(status.sessionId)) continue;
    // "<session>:<window id>.<pane id>"
    const sep = status.tmux.lastIndexOf(':');
    if (sep < 0 || status.tmux.slice(0, sep) !== tmuxSession) continue;
    if (typeof status.pid !== 'number' || !isAlive(status.pid)) continue;
    candidates.push({
      sessionId: status.sessionId,
      pane: status.tmux.slice(status.tmux.lastIndexOf('.') + 1),
      updatedAt: typeof status.updatedAt === 'number' ? status.updatedAt : 0,
    });
  }
  if (candidates.length === 0) return null;
  const inActivePane = activePaneId ? candidates.find((c) => c.pane === activePaneId) : undefined;
  if (inActivePane) return inActivePane.sessionId;
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0].sessionId;
}

const transcriptPathCache = new Map<string, string>();

/** Locate <sessionId>.jsonl under ~/.claude/projects (one directory level). */
function findTranscript(sessionId: string): string | null {
  const cached = transcriptPathCache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  const projectsReal = fs.realpathSync(PROJECTS_DIR);
  for (const dir of dirs) {
    const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    try {
      const real = fs.realpathSync(candidate);
      if (!real.startsWith(projectsReal + path.sep)) continue;
      if (!fs.statSync(real).isFile()) continue;
      transcriptPathCache.set(sessionId, real);
      return real;
    } catch { /* not in this project dir */ }
  }
  return null;
}

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf-8');
    // Drop the partial first line of a mid-file read.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

export type ClaudeReplyResult =
  | { found: true; text: string; blocks: CodeBlock[] }
  | { found: false; reason: string };

function loadEntries(tmuxSession: string, activePaneId: string | null) {
  const sessionId = findClaudeSessionId(tmuxSession, activePaneId);
  if (!sessionId) return { error: 'No Claude Code session is running here.' } as const;
  const file = findTranscript(sessionId);
  if (!file) return { error: "Couldn't find this Claude session's transcript." } as const;
  return { entries: parseTranscriptLines(readTail(file)) } as const;
}

/** Claude's last reply in a tmux session, with its fenced code blocks. */
export function getClaudeReply(tmuxSession: string, activePaneId: string | null): ClaudeReplyResult {
  try {
    const loaded = loadEntries(tmuxSession, activePaneId);
    if ('error' in loaded) return { found: false, reason: loaded.error ?? 'Unavailable' };
    const text = lastReply(loaded.entries);
    if (!text) return { found: false, reason: 'Claude has not replied yet in this session.' };
    return { found: true, text, blocks: extractCodeBlocks(text) };
  } catch (err) {
    return { found: false, reason: `Couldn't read the transcript: ${err instanceof Error ? err.message : err}` };
  }
}

/** All of Claude's recent reply text in a tmux session ('' when unavailable)
 *  — fed to the link harvester so URLs come back whole, never wrap-split. */
export function getClaudeText(tmuxSession: string, activePaneId: string | null): string {
  try {
    const loaded = loadEntries(tmuxSession, activePaneId);
    return 'entries' in loaded && loaded.entries ? assistantTexts(loaded.entries) : '';
  } catch {
    return '';
  }
}
