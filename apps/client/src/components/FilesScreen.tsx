/**
 * @file FilesScreen
 * @description File manager for the active server (File-Share's core behind
 *   PersaLink auth). Opens in ~/shared; tap files to preview (images/text
 *   inline via authed blob fetch), upload into the folder on screen, new
 *   folder, rename, download, delete (to ~/.persalink/trash, kept 30 days).
 *   File-Share gets a link-out button when it answers on :4040.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore, activeServerTls } from '../stores/appStore';
import { schemesFor } from '../lib/platform';
import { uploadFiles } from '../lib/upload';

interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico)$/i;
const TEXT_EXT = /\.(txt|log|md|json|jsx?|tsx?|sh|ya?ml|toml|conf|env|csv|html|css|py|rs|go|c|h|cpp)$/i;
const PREVIEW_TEXT_MAX = 512 * 1024;
const START_PATH = '~/shared';

/** Name prompt for New folder / Rename. */
function NameDialog({ title, initial, action, onSubmit, onCancel }: {
  title: string;
  initial: string;
  action: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension, the way desktop file managers do.
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const trimmed = name.trim();
  const invalid = !trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/');
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <form
        className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (!invalid) onSubmit(trimmed); }}
      >
        <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-100 focus:outline-none focus:border-zinc-500"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {trimmed.includes('/') && <p className="text-xs text-red-400">Names cannot contain /</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-zinc-400 bg-zinc-800 rounded-lg active:bg-zinc-700">
            Cancel
          </button>
          <button type="submit" disabled={invalid} className="px-3 py-1.5 text-sm font-medium text-zinc-900 bg-zinc-100 rounded-lg disabled:opacity-40">
            {action}
          </button>
        </div>
      </form>
    </div>
  );
}

export function FilesScreen() {
  const { serverUrl, authToken, goBack, pushNotification } = useAppStore();
  const [path, setPath] = useState(START_PATH);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [resolvedPath, setResolvedPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<null | { name: string; kind: 'image' | 'text'; url?: string; text?: string }>(null);
  const [fileShareUp, setFileShareUp] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'mkdir' } | { kind: 'rename'; entry: FileEntry }>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const base = `${schemesFor(activeServerTls()).http}${serverUrl.trim().replace(/^(wss?|https?):\/\//i, '')}`;
  const headers: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/api/files/list?path=${encodeURIComponent(target)}`, { headers });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      const data = await res.json() as { path: string; entries: FileEntry[] };
      setEntries(data.entries);
      setResolvedPath(data.path);
      setPath(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read directory');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, authToken]);

  useEffect(() => { void load(START_PATH); }, [load]);

  const fullPath = (entry: FileEntry) => `${resolvedPath.replace(/\/$/, '')}/${entry.name}`;

  const change = async (action: 'mkdir' | 'rename' | 'delete', body: { path: string; name?: string }) => {
    const res = await fetch(`${base}/api/files/${action}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
  };

  const run = async (label: string, work: () => Promise<void>, done?: string) => {
    setBusy(label);
    try {
      await work();
      if (done) pushNotification('info', done, 'files');
    } catch (err) {
      pushNotification('error', err instanceof Error ? err.message : 'Something went wrong', 'files');
    } finally {
      setBusy(null);
      void load(resolvedPath || path);
    }
  };

  const upload = (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0 || !resolvedPath) return;
    const what = list.length === 1 ? list[0].name : `${list.length} files`;
    void run(`Uploading ${what}…`, async () => {
      // One file per request: keeps every request under Cloudflare's 100 MB
      // body limit on term.brobata.com, and a failure names its own file.
      const failed: string[] = [];
      for (const [i, file] of list.entries()) {
        if (list.length > 1) setBusy(`Uploading ${i + 1} of ${list.length}: ${file.name}…`);
        try {
          await uploadFiles([file], { serverUrl, authToken, dir: resolvedPath });
        } catch (err) {
          failed.push(`${file.name}: ${err instanceof Error ? err.message : 'failed'}`);
        }
      }
      if (failed.length) throw new Error(failed.join('\n'));
    }, `Uploaded ${what}`);
  };

  const remove = (entry: FileEntry) => {
    setMenuFor(null);
    const what = entry.type === 'dir' ? `the folder ${entry.name} and everything in it` : entry.name;
    if (!window.confirm(`Delete ${what}?\n\nIt goes to the trash on the server and is kept for 30 days.`)) return;
    void run(`Deleting ${entry.name}…`, () => change('delete', { path: fullPath(entry) }), `Deleted ${entry.name}`);
  };

  const submitDialog = (name: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    if (d.kind === 'mkdir') {
      void run(`Creating ${name}…`, () => change('mkdir', { path: resolvedPath, name }));
    } else if (name !== d.entry.name) {
      void run(`Renaming…`, () => change('rename', { path: fullPath(d.entry), name }));
    }
  };

  // File-Share link-out: probe :4040 on the same host. On https pages the
  // mixed-content rules block the probe itself — the button just won't show.
  useEffect(() => {
    const host = serverUrl.replace(/^(wss?|https?):\/\//i, '').replace(/:\d+$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    fetch(`http://${host}:4040/`, { mode: 'no-cors', signal: ctrl.signal })
      .then(() => setFileShareUp(true))
      .catch(() => setFileShareUp(false))
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [serverUrl]);

  const openEntry = async (entry: FileEntry) => {
    const full = fullPath(entry);
    if (entry.type === 'dir') {
      void load(full);
      return;
    }
    if (IMAGE_EXT.test(entry.name)) {
      try {
        const res = await fetch(`${base}/api/files/download?path=${encodeURIComponent(full)}&inline=1`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const url = URL.createObjectURL(await res.blob());
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = url;
        setPreview({ name: entry.name, kind: 'image', url });
      } catch {
        pushNotification('error', 'Could not load preview.', 'files');
      }
      return;
    }
    if (TEXT_EXT.test(entry.name) && entry.size <= PREVIEW_TEXT_MAX) {
      try {
        const res = await fetch(`${base}/api/files/download?path=${encodeURIComponent(full)}&inline=1`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setPreview({ name: entry.name, kind: 'text', text: await res.text() });
      } catch {
        pushNotification('error', 'Could not load preview.', 'files');
      }
      return;
    }
    void download(entry);
  };

  const download = async (entry: FileEntry) => {
    setMenuFor(null);
    const full = fullPath(entry);
    try {
      const res = await fetch(`${base}/api/files/download?path=${encodeURIComponent(full)}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      pushNotification('error', `Download failed: ${entry.name}`, 'files');
    }
  };

  const goUp = () => {
    if (!resolvedPath || resolvedPath === '/') return;
    const parent = resolvedPath.replace(/\/[^/]+\/?$/, '') || '/';
    void load(parent);
  };

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <header className="shrink-0 px-4 pt-[max(16px,env(safe-area-inset-top))] pb-3 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <button
            onClick={goBack}
            className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded-md active:bg-zinc-700 transition-colors"
          >
            &larr; Back
          </button>
          <h1 className="flex-1 text-lg font-bold">Files</h1>
          <button
            onClick={() => setDialog({ kind: 'mkdir' })}
            disabled={!resolvedPath || !!busy}
            className="px-3 py-1.5 text-xs bg-zinc-800 text-zinc-300 rounded-lg active:bg-zinc-700 disabled:opacity-40"
          >
            New folder
          </button>
          <button
            onClick={() => uploadInputRef.current?.click()}
            disabled={!resolvedPath || !!busy}
            className="px-3 py-1.5 text-xs bg-zinc-100 text-zinc-900 font-medium rounded-lg active:bg-zinc-300 disabled:opacity-40"
          >
            Upload
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => { upload(e.target.files); e.target.value = ''; }}
          />
          {fileShareUp && (
            <a
              href={`http://${serverUrl.replace(/^(wss?|https?):\/\//i, '').replace(/:\d+$/, '')}:4040/`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs bg-zinc-800 text-sky-300 rounded-lg active:bg-zinc-700"
              title="Full file manager (upload, move, rename, ZIP)"
            >
              File-Share ↗
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={goUp}
            disabled={!resolvedPath || resolvedPath === '/'}
            className="shrink-0 px-2.5 py-1 text-sm bg-zinc-800 text-zinc-300 rounded-md active:bg-zinc-700 disabled:opacity-30"
            title="Up one level"
          >
            ↑
          </button>
          <span className="flex-1 min-w-0 text-xs font-mono text-zinc-500 truncate" dir="rtl">{resolvedPath || path}</span>
          <button onClick={() => void load('~/shared')} className="shrink-0 px-2 py-1 text-xs text-zinc-400 bg-zinc-800 rounded-md active:bg-zinc-700">
            Shared
          </button>
          <button onClick={() => void load('~')} className="shrink-0 px-2 py-1 text-xs text-zinc-400 bg-zinc-800 rounded-md active:bg-zinc-700">
            Home
          </button>
        </div>
        {busy && (
          <div className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
            <span className="inline-block w-3 h-3 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
            {busy}
          </div>
        )}
      </header>

      <div
        className={`flex-1 overflow-y-auto px-3 py-3 space-y-1 ${dragOver ? 'ring-2 ring-inset ring-sky-500/60' : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!busy) upload(e.dataTransfer.files); }}
      >
        {loading && (
          <div className="px-3 py-8 text-center text-sm text-zinc-600">
            <span className="inline-block w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin align-middle mr-2" />
            Loading…
          </div>
        )}
        {error && <div className="px-3 py-4 text-sm text-red-400">{error}</div>}
        {!loading && !error && entries.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-zinc-600">Empty directory</div>
        )}
        {!loading && entries.map((entry) => (
          <div key={entry.name} className="relative flex items-center rounded-lg bg-zinc-900/60">
            <button
              onClick={() => void openEntry(entry)}
              className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 text-left active:bg-zinc-800 rounded-l-lg"
            >
              <span className="shrink-0 text-base">
                {entry.type === 'dir' ? '📁' : IMAGE_EXT.test(entry.name) ? '🖼️' : '📄'}
              </span>
              <span className={`flex-1 min-w-0 truncate text-sm ${entry.name.startsWith('.') ? 'text-zinc-500' : 'text-zinc-200'}`}>
                {entry.name}
              </span>
              {entry.type === 'file' && (
                <span className="shrink-0 text-[10px] text-zinc-600">{fmtSize(entry.size)}</span>
              )}
            </button>
            <button
              onClick={() => setMenuFor(menuFor === entry.name ? null : entry.name)}
              disabled={!!busy}
              className="shrink-0 px-3 py-2.5 text-zinc-500 active:text-zinc-200 rounded-r-lg disabled:opacity-40"
              title="More"
              aria-label={`Actions for ${entry.name}`}
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
              </svg>
            </button>
            {menuFor === entry.name && (
              <div className="absolute right-2 top-full mt-1 z-20 min-w-[9rem] py-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl">
                {entry.type === 'file' && (
                  <button onClick={() => void download(entry)} className="block w-full px-3 py-2 text-left text-sm text-zinc-200 active:bg-zinc-700 hover:bg-zinc-700">
                    Download
                  </button>
                )}
                <button
                  onClick={() => { setMenuFor(null); setDialog({ kind: 'rename', entry }); }}
                  className="block w-full px-3 py-2 text-left text-sm text-zinc-200 active:bg-zinc-700 hover:bg-zinc-700"
                >
                  Rename
                </button>
                <button onClick={() => remove(entry)} className="block w-full px-3 py-2 text-left text-sm text-red-400 active:bg-zinc-700 hover:bg-zinc-700">
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {menuFor && <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />}

      {dialog && (
        <NameDialog
          title={dialog.kind === 'mkdir' ? 'New folder' : `Rename ${dialog.entry.name}`}
          initial={dialog.kind === 'mkdir' ? '' : dialog.entry.name}
          action={dialog.kind === 'mkdir' ? 'Create' : 'Rename'}
          onSubmit={submitDialog}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Preview overlay */}
      {preview && (
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
          <div className="shrink-0 flex items-center gap-2 px-4 py-3 bg-zinc-900 border-b border-zinc-800 pt-[max(12px,env(safe-area-inset-top))]">
            <span className="flex-1 min-w-0 text-sm font-mono text-zinc-300 truncate">{preview.name}</span>
            <button
              onClick={() => setPreview(null)}
              className="px-3 py-1.5 text-sm text-zinc-300 bg-zinc-800 active:bg-zinc-700 rounded-lg"
            >
              Close
            </button>
          </div>
          {preview.kind === 'image' ? (
            <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
              <img src={preview.url} alt={preview.name} className="max-w-full max-h-full object-contain" />
            </div>
          ) : (
            <pre className="flex-1 overflow-auto p-4 text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words">
              {preview.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
