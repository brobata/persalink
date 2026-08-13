/**
 * @file FilesScreen
 * @description Read-only file browser for the active server (roadmap Track 4:
 *   File-Share's core ported behind PersaLink auth). Browse from ~, tap files
 *   to preview (images/text inline via authed blob fetch), download anything.
 *   Heavy file management stays in the terminal — or in File-Share, which
 *   gets a link-out button when it answers on :4040.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';

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

export function FilesScreen() {
  const { serverUrl, authToken, goBack, pushNotification } = useAppStore();
  const [path, setPath] = useState('~');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [resolvedPath, setResolvedPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<null | { name: string; kind: 'image' | 'text'; url?: string; text?: string }>(null);
  const [fileShareUp, setFileShareUp] = useState(false);
  const previewUrlRef = useRef<string | null>(null);

  const scheme = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https:' : 'http:';
  const base = `${scheme}//${serverUrl.trim().replace(/^(wss?|https?):\/\//i, '')}`;
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

  useEffect(() => { void load('~'); }, [load]);

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
    const full = `${resolvedPath.replace(/\/$/, '')}/${entry.name}`;
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
    const full = `${resolvedPath.replace(/\/$/, '')}/${entry.name}`;
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
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
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
          <div key={entry.name} className="flex items-center rounded-lg bg-zinc-900/60">
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
            {entry.type === 'file' && (
              <button
                onClick={() => void download(entry)}
                className="shrink-0 px-3 py-2.5 text-zinc-600 active:text-zinc-200 rounded-r-lg"
                title="Download"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

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
