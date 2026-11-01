/**
 * @file Files API client
 * @description Talks to the server's /api/files routes for the Files screen:
 *   listing (with the folder's signed link), changes, uploads with progress,
 *   and URLs for thumbnails / streaming / downloads built from the signed
 *   link (img/video/<a> can't send the bearer header). Also file-kind
 *   detection and the per-server view prefs kept in localStorage.
 */

import { activeServerTls } from '../stores/appStore';
import { isNativeShell, schemesFor } from './platform';
import { isPublicDoor } from './door';
import { openExternal } from './linkOpen';

export interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
  link?: boolean;
  broken?: boolean;
}

export interface FolderLink { dir: string; tid: string; exp: number; sig: string }

export interface Listing {
  path: string;
  home: string;
  parent: string | null;
  readOnly: boolean;
  truncated: boolean;
  entries: FileEntry[];
  link: FolderLink;
}

export interface Conn { serverUrl: string; authToken: string | null }

export function baseUrl(serverUrl: string): string {
  return `${schemesFor(activeServerTls()).http}${serverUrl.trim().replace(/^(wss?|https?):\/\//i, '')}`;
}

function authHeaders(authToken: string | null): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

async function errorOf(res: Response): Promise<Error> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error || `HTTP ${res.status}`);
}

export async function listFolder(conn: Conn, dir: string): Promise<Listing> {
  const res = await fetch(`${baseUrl(conn.serverUrl)}/api/files/list?path=${encodeURIComponent(dir)}`, {
    headers: authHeaders(conn.authToken),
  });
  if (!res.ok) throw await errorOf(res);
  return res.json();
}

export async function fileAction<T = unknown>(conn: Conn, action: string, body: object): Promise<T> {
  const res = await fetch(`${baseUrl(conn.serverUrl)}/api/files/${action}`, {
    method: 'POST',
    headers: { ...authHeaders(conn.authToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorOf(res);
  return res.json();
}

export interface MoveResult { done: { from: string; to: string; renamed: boolean }[]; failed: { from: string; error: string }[] }

export interface TextFile {
  /** With \n line endings (what a textarea gives back). */
  text: string;
  /** The file used \r\n — converted back on save so untouched lines stay byte-identical. */
  crlf: boolean;
  /** The mtime the editor must send back on save. */
  mtime: number;
}

/** Text content, or an error for anything that isn't valid UTF-8 (editing
 *  that would write replacement characters over the real bytes). A BOM is
 *  kept in the text, so it survives a save. */
export async function readText(conn: Conn, file: string): Promise<TextFile> {
  const res = await fetch(`${baseUrl(conn.serverUrl)}/api/files/download?path=${encodeURIComponent(file)}&inline=1`, {
    headers: authHeaders(conn.authToken),
  });
  if (!res.ok) throw await errorOf(res);
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await res.arrayBuffer());
  } catch {
    throw new Error('Not plain UTF-8 text — download it instead.');
  }
  const crlf = raw.includes('\r\n');
  return { text: crlf ? raw.replace(/\r\n/g, '\n') : raw, crlf, mtime: Number(res.headers.get('X-File-Mtime')) };
}

function signedQuery(link: FolderLink): URLSearchParams {
  return new URLSearchParams({ dir: link.dir, tid: link.tid, exp: String(link.exp), sig: link.sig });
}

/** Inline URL (thumbnails, <video>, open in a tab) or a download (`dl`).
 *  The mtime makes a replaced file a new URL, so the browser cache can't
 *  show the old picture under the same name. */
export function rawUrl(serverUrl: string, link: FolderLink, entry: Pick<FileEntry, 'name' | 'mtime'>, dl = false): string {
  const q = signedQuery(link);
  q.set('name', entry.name);
  q.set('v', String(entry.mtime));
  if (dl) q.set('dl', '1');
  return `${baseUrl(serverUrl)}/api/files/raw?${q}`;
}

export function zipUrl(serverUrl: string, link: FolderLink, names: string[]): string {
  const q = signedQuery(link);
  for (const n of names) q.append('n', n);
  return `${baseUrl(serverUrl)}/api/files/zip?${q}`;
}

/** Start a browser download without leaving the page. The native shell
 *  hands it to the phone's browser, which downloads with the signed link. */
export function startDownload(url: string): void {
  if (isNativeShell()) { openExternal(url); return; }
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** One file into `dir`, reporting progress (fetch can't report upload progress). */
export function uploadOne(
  conn: Conn,
  dir: string,
  file: File,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl(conn.serverUrl)}/api/upload?dir=${encodeURIComponent(dir)}`);
    if (conn.authToken) xhr.setRequestHeader('Authorization', `Bearer ${conn.authToken}`);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body: { error?: string; files?: { name: string }[] } | null = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* HTML error page (e.g. Cloudflare 413) */ }
      if (xhr.status >= 200 && xhr.status < 300 && body?.files?.[0]) resolve(body.files[0].name);
      else reject(new Error(body?.error || (xhr.status === 413 ? 'Too large to upload' : `upload failed (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error('Connection lost during upload'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export type FileKind = 'dir' | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'archive' | 'other';

const KIND_BY_EXT: Record<string, FileKind> = {};
const add = (kind: FileKind, exts: string) => { for (const e of exts.split(' ')) KIND_BY_EXT[e] = kind; };
add('image', 'png jpg jpeg gif webp svg ico bmp avif');
add('video', 'mp4 m4v mov webm');
add('audio', 'mp3 m4a aac wav ogg flac opus');
add('pdf', 'pdf');
add('archive', 'zip gz tgz tar xz bz2 7z rar');
add('text', 'txt log md json jsonl js jsx ts tsx mjs cjs sh bash zsh ps1 yml yaml toml ini conf cfg env csv tsv '
  + 'html htm css scss xml py rb rs go java kt swift c h cpp hpp cs php sql lua vim gitignore dockerfile makefile');

export function kindOf(entry: Pick<FileEntry, 'name' | 'type'>): FileKind {
  if (entry.type === 'dir') return 'dir';
  const lower = entry.name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  return KIND_BY_EXT[ext] ?? (lower.startsWith('.') ? 'text' : 'other');
}

export const TEXT_EDIT_MAX = 2 * 1024 * 1024;

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/$/, '')}/${name}`;
}

export function tildePath(p: string, home: string | null): string {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

// ---------------------------------------------------------------------------
// Prefs (per device, per server)
// ---------------------------------------------------------------------------

export type SortKey = 'name' | 'mtime' | 'size' | 'type';
export interface FilesPrefs {
  view: 'list' | 'grid';
  sort: SortKey;
  desc: boolean;
  showHidden: boolean;
  lastPath: string;
  pins: string[];
}

const DEFAULT_PREFS: FilesPrefs = { view: 'list', sort: 'name', desc: false, showHidden: false, lastPath: '~/shared', pins: [] };

// The outside door keeps nothing past the tab (shared work laptop).
const prefsStore = (): Storage => (isPublicDoor ? sessionStorage : localStorage);

export function loadPrefs(serverUrl: string): FilesPrefs {
  try {
    const raw = prefsStore().getItem(`pl-files:${serverUrl}`);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(serverUrl: string, prefs: FilesPrefs): void {
  try { prefsStore().setItem(`pl-files:${serverUrl}`, JSON.stringify(prefs)); } catch { /* private mode */ }
}
