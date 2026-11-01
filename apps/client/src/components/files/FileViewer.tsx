/**
 * @file FileViewer
 * @description Full-screen viewer for the Files screen: photos (tap to zoom),
 *   video and audio (streamed with range requests from the folder's signed
 *   link), PDFs (open in a tab), text/code (view + edit + save, refusing to
 *   clobber a file that changed on the server). Prev/next with the arrows,
 *   ←/→ keys or a sideways swipe walks every file in the folder in the order
 *   shown. Download, share (phones) and delete from the header.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileQuestion, Pencil, Save, Share2, Trash2, X } from 'lucide-react';
import {
  type Conn, type FileEntry, type FolderLink, TEXT_EDIT_MAX, fileAction, fmtSize, joinPath, kindOf, rawUrl, readText, startDownload,
} from '../../lib/files';
import { openExternal } from '../../lib/linkOpen';

interface Props {
  conn: Conn;
  dir: string;
  link: FolderLink;
  readOnly: boolean;
  items: FileEntry[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDelete: (entry: FileEntry) => void;
  onSaved: () => void;
  notify: (kind: 'error' | 'info', message: string) => void;
}

const SWIPE_MIN = 60;

export function FileViewer({ conn, dir, link, readOnly, items, index, onIndex, onClose, onDelete, onSaved, notify }: Props) {
  const entry = items[index];
  const kind = entry ? kindOf(entry) : 'other';
  const src = entry ? rawUrl(conn.serverUrl, link, entry) : '';
  const [zoomed, setZoomed] = useState(false);
  const [text, setText] = useState<{ name: string; body: string; crlf: boolean; mtime: number } | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null); // non-null = editing
  const [saving, setSaving] = useState(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const dirty = draft !== null && text !== null && draft !== text.body;

  // Text: load on arrival (small files only), reset per file.
  useEffect(() => {
    setZoomed(false);
    setDraft(null);
    setText(null);
    setTextError(null);
    if (!entry || kind !== 'text') return;
    if (entry.size > TEXT_EDIT_MAX) { setTextError(`Too big to show here (${fmtSize(entry.size)}) — download it instead.`); return; }
    let cancelled = false;
    readText(conn, joinPath(dir, entry.name)).then(
      ({ text: body, crlf, mtime }) => { if (!cancelled) setText({ name: entry.name, body, crlf, mtime }); },
      (err: Error) => { if (!cancelled) setTextError(err.message); },
    );
    return () => { cancelled = true; };
    // A re-listing hands over new objects for the same file — only a different
    // file (or a changed one) reloads, so a refresh never wipes an edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.name, entry?.mtime, kind, conn.serverUrl, conn.authToken, dir]);

  const leave = useCallback((go: () => void) => {
    if (dirty && !window.confirm('Discard your changes?')) return;
    go();
  }, [dirty]);

  const step = useCallback((delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    leave(() => onIndex(next));
  }, [index, items.length, leave, onIndex]);

  const save = useCallback(async () => {
    if (!entry || !text || draft === null || saving) return;
    setSaving(true);
    try {
      const content = text.crlf ? draft.replace(/\n/g, '\r\n') : draft;
      const { mtime } = await fileAction<{ mtime: number }>(conn, 'save', { path: joinPath(dir, entry.name), content, mtime: text.mtime });
      setText({ ...text, body: draft, mtime });
      setDraft(null);
      notify('info', `Saved ${entry.name}`);
      onSaved();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [entry, text, draft, saving, conn, dir, notify, onSaved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && draft !== null) { e.preventDefault(); void save(); return; }
      if (draft !== null) { if (e.key === 'Escape') leave(() => setDraft(null)); return; }
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, save, leave, onClose, step]);

  const share = async () => {
    if (!entry) return;
    try {
      const blob = await (await fetch(src)).blob();
      const file = new File([blob], entry.name, { type: blob.type });
      if (!navigator.canShare?.({ files: [file] })) throw new Error('This browser cannot share files');
      await navigator.share({ files: [file] });
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') notify('error', err instanceof Error ? err.message : 'Share failed');
    }
  };

  if (!entry) return null;
  const canShare = typeof navigator.share === 'function' && entry.size <= 50 * 1024 * 1024;
  const swipeable = draft === null && !zoomed;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <header className="shrink-0 flex items-center gap-1 px-2 pb-2 pt-[max(8px,env(safe-area-inset-top))] bg-zinc-950/90 border-b border-zinc-800">
        <button onClick={() => leave(onClose)} className="p-2 text-zinc-300 rounded-lg active:bg-zinc-800 hover:bg-zinc-800" title="Close (Esc)">
          <X className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0 px-1">
          <div className="text-sm text-zinc-100 truncate">{entry.name}</div>
          <div className="text-[11px] text-zinc-500">{index + 1} of {items.length} · {fmtSize(entry.size)}</div>
        </div>
        {kind === 'text' && !readOnly && text && draft === null && (
          <button onClick={() => setDraft(text.body)} className="p-2 text-zinc-300 rounded-lg active:bg-zinc-800 hover:bg-zinc-800" title="Edit">
            <Pencil className="w-5 h-5" />
          </button>
        )}
        {draft !== null && (
          <>
            <button onClick={() => leave(() => setDraft(null))} className="px-3 py-1.5 text-sm text-zinc-300 bg-zinc-800 rounded-lg">Cancel</button>
            <button
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="ml-1 flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-zinc-900 bg-zinc-100 rounded-lg disabled:opacity-40"
              title="Save (Ctrl+S)"
            >
              <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
        {draft === null && (
          <>
            {canShare && (
              <button onClick={() => void share()} className="p-2 text-zinc-300 rounded-lg active:bg-zinc-800 hover:bg-zinc-800" title="Share">
                <Share2 className="w-5 h-5" />
              </button>
            )}
            <button onClick={() => startDownload(rawUrl(conn.serverUrl, link, entry, true))} className="p-2 text-zinc-300 rounded-lg active:bg-zinc-800 hover:bg-zinc-800" title="Download">
              <Download className="w-5 h-5" />
            </button>
            {!readOnly && (
              <button onClick={() => onDelete(entry)} className="p-2 text-red-400 rounded-lg active:bg-zinc-800 hover:bg-zinc-800" title="Delete">
                <Trash2 className="w-5 h-5" />
              </button>
            )}
          </>
        )}
      </header>

      <div
        className="relative flex-1 min-h-0 flex"
        onPointerDown={(e) => { if (swipeable && e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) step(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={() => { swipe.current = null; }}
      >
        {kind === 'image' && (
          <div className={`flex-1 ${zoomed ? 'overflow-auto' : 'overflow-hidden flex items-center justify-center p-2'}`}>
            <img
              key={src}
              src={src}
              alt={entry.name}
              onClick={() => setZoomed((z) => !z)}
              className={zoomed ? 'max-w-none cursor-zoom-out' : 'max-w-full max-h-full object-contain cursor-zoom-in select-none'}
              draggable={false}
            />
          </div>
        )}
        {kind === 'video' && (
          <div className="flex-1 flex items-center justify-center bg-black">
            <video key={src} src={src} controls autoPlay playsInline className="max-w-full max-h-full" />
          </div>
        )}
        {kind === 'audio' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
            <div className="text-zinc-300 text-center break-all">{entry.name}</div>
            <audio key={src} src={src} controls autoPlay className="w-full max-w-md" />
          </div>
        )}
        {kind === 'text' && (
          <div className="flex-1 min-w-0 flex flex-col">
            {textError && <div className="p-6 text-sm text-zinc-400">{textError}</div>}
            {!textError && !text && <div className="p-6 text-sm text-zinc-500">Loading…</div>}
            {text && draft === null && (
              <pre className="flex-1 overflow-auto p-4 text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words select-text">
                {text.body || <span className="text-zinc-600">Empty file</span>}
              </pre>
            )}
            {draft !== null && (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="flex-1 w-full resize-none p-4 bg-zinc-950 text-[13px] leading-relaxed font-mono text-zinc-100 focus:outline-none"
              />
            )}
          </div>
        )}
        {(kind === 'pdf' || kind === 'archive' || kind === 'other' || kind === 'dir') && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <FileQuestion className="w-12 h-12 text-zinc-600" />
            <div className="text-sm text-zinc-300 break-all">{entry.name}</div>
            <div className="text-xs text-zinc-500">{fmtSize(entry.size)}</div>
            <div className="flex gap-2">
              {kind === 'pdf' && (
                <button onClick={() => openExternal(src)} className="flex items-center gap-1.5 px-4 py-2 text-sm text-zinc-900 bg-zinc-100 rounded-lg font-medium">
                  <ExternalLink className="w-4 h-4" /> Open
                </button>
              )}
              <button onClick={() => startDownload(rawUrl(conn.serverUrl, link, entry, true))} className="flex items-center gap-1.5 px-4 py-2 text-sm text-zinc-200 bg-zinc-800 rounded-lg">
                <Download className="w-4 h-4" /> Download
              </button>
            </div>
          </div>
        )}

        {draft === null && index > 0 && (
          <button onClick={() => step(-1)} className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-zinc-200 hover:bg-black/70" title="Previous (←)">
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        {draft === null && index < items.length - 1 && (
          <button onClick={() => step(1)} className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-zinc-200 hover:bg-black/70" title="Next (→)">
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
      </div>
    </div>
  );
}
