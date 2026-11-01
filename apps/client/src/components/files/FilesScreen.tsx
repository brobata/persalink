/**
 * @file FilesScreen
 * @description File manager for the active server — File-Share's web app
 *   behind PersaLink's login. Path bar with tappable segments (tap the path
 *   to type one), pinned folders, search, sort, list or grid (photo
 *   thumbnails), multi-select, cut/copy/paste between folders, drag to move
 *   (desktop), right-click / ⋯ menus, uploads with progress (files, folders,
 *   camera), zip download, and the FileViewer for everything else. Phones:
 *   tap opens, long-press selects. Desktop: click selects, double-click opens,
 *   with the usual keys. Opens in the last folder (default ~/shared).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ArrowDownAZ, ArrowLeft, ArrowUp, Camera, Check, ClipboardPaste, Copy, Download, Eye, EyeOff, File as FileIcon, FileArchive,
  FileAudio, FileCode, FilePlus, FileText, FileVideo, Folder, FolderInput, FolderPlus, FolderUp, Image as ImageIcon, LayoutGrid,
  Link2, List, MoreVertical, Pencil, RefreshCw, Scissors, Search, Star, Trash2, Upload, X,
} from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useLongPress } from '../../lib/useLongPress';
import {
  type FileEntry, type FileKind, type FilesPrefs, type Listing, type MoveResult, type SortKey,
  fileAction, fmtDate, fmtSize, joinPath, kindOf, listFolder, loadPrefs, rawUrl, savePrefs, startDownload, tildePath, uploadOne, zipUrl,
} from '../../lib/files';
import { FileViewer } from './FileViewer';

const finePointer = () => typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;

const KIND_ICON: Record<FileKind, typeof FileIcon> = {
  dir: Folder, image: ImageIcon, video: FileVideo, audio: FileAudio, pdf: FileText, text: FileCode, archive: FileArchive, other: FileIcon,
};
const KIND_COLOR: Record<FileKind, string> = {
  dir: 'text-sky-400', image: 'text-emerald-400', video: 'text-violet-400', audio: 'text-pink-400',
  pdf: 'text-red-400', text: 'text-amber-300', archive: 'text-orange-400', other: 'text-zinc-400',
};

interface Clip { mode: 'move' | 'copy'; paths: string[]; from: string }
interface Upload { name: string; size: number; loaded: number; state: 'waiting' | 'sending' | 'done' | 'failed'; error?: string }
type Dialog = { kind: 'mkdir' } | { kind: 'newfile' } | { kind: 'rename'; entry: FileEntry };
interface Menu { x: number; y: number; entries: FileEntry[] | null } // null = the empty-space menu

/** Name prompt for New folder / New file / Rename. */
function NameDialog({ title, initial, action, onSubmit, onCancel }: {
  title: string; initial: string; action: string; onSubmit: (name: string) => void; onCancel: () => void;
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
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <form
        className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (!invalid) onSubmit(trimmed); }}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); e.stopPropagation(); }}
      >
        <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-100 focus:outline-none focus:border-zinc-500"
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />
        {trimmed.includes('/') && <p className="text-xs text-red-400">Names cannot contain /</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-zinc-400 bg-zinc-800 rounded-lg active:bg-zinc-700">Cancel</button>
          <button type="submit" disabled={invalid} className="px-3 py-1.5 text-sm font-medium text-zinc-900 bg-zinc-100 rounded-lg disabled:opacity-40">{action}</button>
        </div>
      </form>
    </div>
  );
}

function ToolButton({ onClick, title, active, disabled, children }: {
  onClick: () => void; title: string; active?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`shrink-0 p-2 rounded-lg transition-colors disabled:opacity-30 ${active ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 active:bg-zinc-800 hover:text-zinc-200'}`}
    >
      {children}
    </button>
  );
}

/** Thumbnail or icon for a row/tile. */
function EntryIcon({ entry, thumb, big }: { entry: FileEntry; thumb: string | null; big?: boolean }) {
  const kind = kindOf(entry);
  const [failed, setFailed] = useState(false);
  const Icon = KIND_ICON[kind];
  if (thumb && !failed && kind === 'image') {
    return (
      <img
        src={thumb}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        draggable={false}
        className={big ? 'w-full h-full object-cover' : 'w-9 h-9 rounded object-cover bg-zinc-800'}
      />
    );
  }
  if (thumb && !failed && kind === 'video' && big) {
    return <video src={`${thumb}#t=0.5`} preload="metadata" muted playsInline onError={() => setFailed(true)} className="w-full h-full object-cover pointer-events-none" />;
  }
  return <Icon className={`${big ? 'w-10 h-10' : 'w-6 h-6 mx-1.5'} ${KIND_COLOR[kind]} ${entry.broken ? 'opacity-40' : ''}`} strokeWidth={1.6} />;
}

interface ItemProps {
  entry: FileEntry;
  view: 'list' | 'grid';
  desktop: boolean;
  selected: boolean;
  showChecks: boolean;
  draggable: boolean;
  dropActive: boolean;
  thumb: string | null;
  onActivate: (e: ReactMouseEvent) => void;
  onLongPress: () => void;
  onOpen: () => void;
  onMenu: (e: ReactMouseEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  /** Only folders take drops. */
  drop?: { over: (e: DragEvent) => void; leave: () => void; drop: (e: DragEvent) => void };
}

/** One row (list) or tile (grid). Phones: tap = activate, hold = select. */
function EntryItem({ entry, view, desktop, selected, showChecks, draggable, dropActive, thumb, onActivate, onLongPress, onOpen, onMenu, onDragStart, onDragEnd, drop }: ItemProps) {
  const press = useLongPress(onLongPress, onActivate);
  const handlers = desktop ? { onClick: onActivate } : press;
  const shared = {
    draggable,
    onDragStart,
    onDragEnd,
    onDragOver: drop?.over,
    onDragLeave: drop?.leave,
    onDrop: drop ? (e: DragEvent) => { e.stopPropagation(); drop.drop(e); } : undefined,
    onContextMenu: onMenu,
    onDoubleClick: desktop ? onOpen : undefined,
  };
  const actions = (
    <button
      onClick={onMenu}
      onDoubleClick={(e) => e.stopPropagation()}
      className="shrink-0 p-2 text-zinc-500 hover:text-zinc-200 active:text-zinc-200 rounded-lg"
      title="More" aria-label={`Actions for ${entry.name}`}
    >
      <MoreVertical className="w-4 h-4" />
    </button>
  );
  const check = (round: boolean) => (
    <span className={`shrink-0 w-5 h-5 ${round ? 'rounded-full' : 'rounded'} border flex items-center justify-center ${selected ? 'bg-sky-500 border-sky-500' : round ? 'bg-black/40 border-zinc-300' : 'border-zinc-600'}`}>
      {selected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
    </span>
  );

  if (view === 'grid') {
    return (
      <div {...shared} className={`relative rounded-xl overflow-hidden select-none ${selected ? 'ring-2 ring-sky-500' : ''} ${dropActive ? 'ring-2 ring-sky-400' : ''}`}>
        <button {...handlers} className="block w-full text-left">
          <span className="flex aspect-square bg-zinc-900 items-center justify-center overflow-hidden">
            <EntryIcon entry={entry} thumb={thumb} big />
          </span>
          <span className="block px-1.5 py-1 text-xs text-zinc-200 truncate bg-zinc-900/80">{entry.name}</span>
        </button>
        {(showChecks || selected) && <span className="absolute top-1.5 left-1.5">{check(true)}</span>}
        <span className="absolute top-0.5 right-0.5 bg-black/40 rounded-lg">{actions}</span>
      </div>
    );
  }
  return (
    <div {...shared} className={`flex items-center rounded-lg select-none ${selected ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'hover:bg-zinc-800/60'} ${dropActive ? 'ring-2 ring-sky-400 bg-sky-500/10' : ''}`}>
      <button {...handlers} className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left">
        {showChecks && check(false)}
        <span className="shrink-0 w-9 h-9 flex items-center justify-center"><EntryIcon entry={entry} thumb={thumb} /></span>
        <span className="flex-1 min-w-0">
          <span className={`block truncate text-sm ${entry.name.startsWith('.') ? 'text-zinc-500' : 'text-zinc-100'}`}>
            {entry.name}{entry.link && <Link2 className="inline w-3 h-3 ml-1 text-zinc-500" />}
          </span>
          <span className="block sm:hidden text-[11px] text-zinc-500">
            {entry.type === 'file' ? `${fmtSize(entry.size)} · ` : ''}{fmtDate(entry.mtime)}
          </span>
        </span>
        <span className="hidden sm:block shrink-0 w-28 text-right text-xs text-zinc-500">{fmtDate(entry.mtime)}</span>
        <span className="hidden sm:block shrink-0 w-20 text-right text-xs text-zinc-500">{entry.type === 'file' ? fmtSize(entry.size) : ''}</span>
      </button>
      {actions}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger, disabled }: { icon: typeof FileIcon; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm disabled:opacity-30 hover:bg-zinc-700/70 active:bg-zinc-700 ${danger ? 'text-red-400' : 'text-zinc-200'}`}
    >
      <Icon className="w-4 h-4 shrink-0" /> {label}
    </button>
  );
}

export function FilesScreen() {
  const { serverUrl, authToken, goBack, pushNotification } = useAppStore();
  const conn = useMemo(() => ({ serverUrl, authToken }), [serverUrl, authToken]);
  const notify = useCallback((kind: 'error' | 'info', message: string) => pushNotification(kind, message, 'files'), [pushNotification]);
  const desktop = useMemo(finePointer, []);

  const [prefs, setPrefs] = useState<FilesPrefs>(() => loadPrefs(serverUrl));
  const updatePrefs = (patch: Partial<FilesPrefs>) => setPrefs((p) => { const next = { ...p, ...patch }; savePrefs(serverUrl, next); return next; });

  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false); // phones: long-press entered it
  const [clip, setClip] = useState<Clip | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null); // open file's name: survives re-sorting
  const [busy, setBusy] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder name, '.' = here
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragNames = useRef<string[] | null>(null);
  const loadSeq = useRef(0);
  const pathRef = useRef<string | null>(null);

  const dir = listing?.path ?? '';
  const home = listing?.home ?? null;
  const readOnly = !!listing?.readOnly;

  const load = useCallback(async (target: string, keepSelection = false) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const next = await listFolder(conn, target);
      if (seq !== loadSeq.current) return;
      if (!keepSelection || pathRef.current !== next.path) {
        setSelected(new Set());
        setAnchor(null);
        setSelectMode(false);
        setQuery('');
      }
      else {
        // Renamed / moved / deleted meanwhile: drop names that are gone.
        const names = new Set(next.entries.map((x) => x.name));
        setSelected((sel) => (Array.from(sel).every((n) => names.has(n)) ? sel : new Set(Array.from(sel).filter((n) => names.has(n)))));
      }
      pathRef.current = next.path;
      setListing(next);
      setPrefs((p) => { const np = { ...p, lastPath: tildePath(next.path, next.home) }; savePrefs(serverUrl, np); return np; });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err instanceof Error ? err.message : 'Could not open that folder');
      // Last folder gone (deleted elsewhere): fall back once to ~/shared.
      if (!pathRef.current && target !== '~/shared' && target !== '~') void load('~/shared');
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, serverUrl]);

  useEffect(() => { void load(prefs.lastPath || '~/shared'); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  // The folder on screen *now* — a long upload finishing must not pull the
  // user back to the folder it started in.
  const refresh = useCallback(() => { if (pathRef.current) void load(pathRef.current, true); }, [load]);

  // ---- derived list -------------------------------------------------------
  const shown = useMemo(() => {
    const all = listing?.entries ?? [];
    const q = query.trim().toLowerCase();
    const filtered = all.filter((e) => (prefs.showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
    const dirFirst = (a: FileEntry, b: FileEntry) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1);
    const cmp: Record<SortKey, (a: FileEntry, b: FileEntry) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      mtime: (a, b) => a.mtime - b.mtime,
      size: (a, b) => a.size - b.size,
      type: (a, b) => kindOf(a).localeCompare(kindOf(b)) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    };
    return [...filtered].sort((a, b) => dirFirst(a, b) || (prefs.desc ? -1 : 1) * cmp[prefs.sort](a, b));
  }, [listing, query, prefs.showHidden, prefs.sort, prefs.desc]);
  const viewable = useMemo(() => shown.filter((e) => e.type === 'file'), [shown]);
  const viewerIndex = viewer === null ? -1 : viewable.findIndex((e) => e.name === viewer);
  // The open file vanished (deleted/renamed elsewhere): close the viewer for real.
  useEffect(() => { if (viewer !== null && listing && viewerIndex < 0) setViewer(null); }, [viewer, viewerIndex, listing]);
  const hiddenCount = (listing?.entries ?? []).filter((e) => e.name.startsWith('.')).length;
  const selectedEntries = shown.filter((e) => selected.has(e.name));
  const selectedBytes = selectedEntries.reduce((n, e) => n + (e.type === 'file' ? e.size : 0), 0);
  const thumb = (e: FileEntry) => (listing && (kindOf(e) === 'image' || kindOf(e) === 'video') ? rawUrl(serverUrl, listing.link, e) : null);

  // ---- actions ------------------------------------------------------------
  const run = async (label: string, work: () => Promise<void>, done?: string) => {
    setBusy(label);
    try {
      await work();
      if (done) notify('info', done);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const open = (entry: FileEntry) => {
    if (entry.type === 'dir') { void load(joinPath(dir, entry.name)); return; }
    const i = viewable.findIndex((e) => e.name === entry.name);
    if (i >= 0) setViewer(entry.name);
  };

  const download = (entries: FileEntry[]) => {
    if (!listing || entries.length === 0) return;
    if (entries.length === 1 && entries[0].type === 'file') startDownload(rawUrl(serverUrl, listing.link, entries[0], true));
    else startDownload(zipUrl(serverUrl, listing.link, entries.map((e) => e.name)));
  };

  const remove = (entries: FileEntry[]) => {
    if (entries.length === 0) return;
    const what = entries.length > 1 ? `${entries.length} items` : entries[0].type === 'dir' ? `the folder ${entries[0].name} and everything in it` : entries[0].name;
    if (!window.confirm(`Delete ${what}?\n\nIt goes to the trash on the server and is kept for 30 days.`)) return;
    setViewer(null);
    void run(`Deleting ${entries.length > 1 ? `${entries.length} items` : entries[0].name}…`, async () => {
      const failed: string[] = [];
      for (const e of entries) {
        try { await fileAction(conn, 'delete', { path: joinPath(dir, e.name) }); } catch (err) { failed.push(`${e.name}: ${err instanceof Error ? err.message : 'failed'}`); }
      }
      if (failed.length) throw new Error(failed.join('\n'));
    }, entries.length > 1 ? `Deleted ${entries.length} items` : `Deleted ${entries[0].name}`);
  };

  const transfer = (mode: 'move' | 'copy', paths: string[], to: string) => {
    const verb = mode === 'move' ? 'Mov' : 'Copy';
    void run(`${verb}ing ${paths.length > 1 ? `${paths.length} items` : paths[0].split('/').pop()}…`, async () => {
      const r = await fileAction<MoveResult>(conn, mode, { paths, to });
      if (r.failed.length) throw new Error(r.failed.map((f) => `${f.from.split('/').pop()}: ${f.error}`).join('\n'));
      const renamed = r.done.filter((d) => d.renamed).length;
      if (r.done.length) notify('info', `${mode === 'move' ? 'Moved' : 'Copied'} ${r.done.length} item${r.done.length > 1 ? 's' : ''}${renamed ? ` (${renamed} renamed — that name was taken)` : ''}`);
    });
  };

  const paste = () => {
    if (!clip || !dir) return;
    transfer(clip.mode, clip.paths, dir);
    if (clip.mode === 'move') setClip(null);
  };

  const toClip = (mode: 'move' | 'copy', entries: FileEntry[]) => {
    if (entries.length === 0) return;
    setClip({ mode, paths: entries.map((e) => joinPath(dir, e.name)), from: dir });
    setSelected(new Set());
    setSelectMode(false);
    notify('info', `${entries.length > 1 ? `${entries.length} items` : entries[0].name} ready — open the folder you want, then Paste here`);
  };

  const copyPaths = async (entries: FileEntry[]) => {
    const text = (entries.length ? entries.map((e) => tildePath(joinPath(dir, e.name), home)) : [tildePath(dir, home)])
      .map((p) => (/[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p)).join(' ');
    try {
      await navigator.clipboard.writeText(text);
      notify('info', 'Path copied');
    } catch {
      window.prompt('Copy the path:', text);
    }
  };

  const submitDialog = (name: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    if (d.kind === 'mkdir') void run(`Creating ${name}…`, () => fileAction(conn, 'mkdir', { path: dir, name }).then(() => undefined));
    else if (d.kind === 'newfile') void run(`Creating ${name}…`, () => fileAction(conn, 'newfile', { path: dir, name }).then(() => undefined));
    else if (name !== d.entry.name) void run('Renaming…', () => fileAction(conn, 'rename', { path: joinPath(dir, d.entry.name), name }).then(() => undefined));
  };

  /** Files (with folder-relative paths for a folder upload) into `target`. */
  const upload = async (files: File[], target = dir) => {
    if (!target || files.length === 0) return;
    if (uploads.some((u) => u.state === 'waiting' || u.state === 'sending')) { notify('error', 'Wait for the current upload to finish'); return; }
    const ctrl = new AbortController();
    uploadAbort.current = ctrl;
    setUploads(files.map((f) => ({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, size: f.size, loaded: 0, state: 'waiting' })));
    const made = new Set<string>();
    for (const [i, file] of files.entries()) {
      if (ctrl.signal.aborted) break;
      const patch = (p: Partial<Upload>) => setUploads((list) => list.map((u, j) => (j === i ? { ...u, ...p } : u)));
      patch({ state: 'sending' });
      try {
        // Folder upload: make each sub-folder first (already there is fine).
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
        const parts = rel.split('/').slice(0, -1);
        let into = target;
        for (const part of parts) {
          const next = joinPath(into, part);
          if (!made.has(next)) {
            await fileAction(conn, 'mkdir', { path: into, name: part }).catch((err: Error) => { if (!/taken/.test(err.message)) throw err; });
            made.add(next);
          }
          into = next;
        }
        await uploadOne(conn, into, file, (loaded) => patch({ loaded }), ctrl.signal);
        patch({ state: 'done', loaded: file.size });
      } catch (err) {
        patch({ state: 'failed', error: err instanceof Error ? err.message : 'failed' });
      }
    }
    uploadAbort.current = null;
    refresh();
    setUploads((list) => {
      const failed = list.filter((u) => u.state === 'failed').length;
      if (!failed) { setTimeout(() => setUploads((l) => (l === list ? [] : l)), 2500); }
      return list;
    });
  };

  // ---- selection / clicks -------------------------------------------------
  const toggle = (name: string) => setSelected((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });

  const onRowClick = (entry: FileEntry, e: ReactMouseEvent) => {
    setMenu(null);
    if (!desktop) {
      if (selectMode || selected.size) { toggle(entry.name); return; }
      open(entry);
      return;
    }
    if (e.shiftKey && anchor) {
      const names = shown.map((x) => x.name);
      const [a, b] = [names.indexOf(anchor), names.indexOf(entry.name)].sort((x, y) => x - y);
      setSelected(new Set(names.slice(a, b + 1)));
      return;
    }
    if (e.ctrlKey || e.metaKey) { toggle(entry.name); setAnchor(entry.name); return; }
    setSelected(new Set([entry.name]));
    setAnchor(entry.name);
  };

  /** Part of the selection → acts on the whole selection; otherwise on just
   *  this item. Only a desktop right-click also moves the selection to it. */
  const showMenu = (e: ReactMouseEvent, entry: FileEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    const fromButton = e.type === 'click';
    let entries: FileEntry[] | null = null;
    if (entry) {
      if (selected.has(entry.name)) entries = shown.filter((x) => selected.has(x.name));
      else {
        entries = [entry];
        if (desktop && !fromButton) { setSelected(new Set([entry.name])); setAnchor(entry.name); }
      }
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: fromButton ? rect.right : e.clientX, y: fromButton ? rect.bottom : e.clientY, entries });
  };

  // Escape in selection mode on phones also leaves it
  useEffect(() => { if (selected.size === 0) setSelectMode(false); }, [selected.size]);

  // ---- keyboard (desktop) -------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewer !== null || dialog) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') { (t as HTMLInputElement).blur(); setQuery(''); setSearchOpen(false); setEditingPath(null); }
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const sel = shown.filter((x) => selected.has(x.name));
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(new Set(shown.map((x) => x.name))); }
      else if (mod && e.key.toLowerCase() === 'c' && sel.length) { e.preventDefault(); toClip('copy', sel); }
      else if (mod && e.key.toLowerCase() === 'x' && sel.length && !readOnly) { e.preventDefault(); toClip('move', sel); }
      else if (mod && e.key.toLowerCase() === 'v' && clip && !readOnly) { e.preventDefault(); paste(); }
      else if (e.key === 'Escape') { setMenu(null); setSelected(new Set()); }
      else if ((e.key === 'Delete' || (e.key === 'Backspace' && mod)) && sel.length && !readOnly) { e.preventDefault(); remove(sel); }
      else if (e.key === 'F2' && sel.length === 1 && !readOnly) { e.preventDefault(); setDialog({ kind: 'rename', entry: sel[0] }); }
      else if (e.key === 'Enter' && sel.length === 1) { e.preventDefault(); open(sel[0]); }
      else if ((e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) && listing?.parent) { e.preventDefault(); void load(listing.parent); }
      else if (e.key === '/') { e.preventDefault(); setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 0); }
      else if (e.key === 'F5') { e.preventDefault(); refresh(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- drag and drop ------------------------------------------------------
  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const onDragOverTarget = (e: DragEvent, target: string) => {
    if (!isFileDrag(e) && !dragNames.current) return;
    if (readOnly) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragNames.current ? (e.ctrlKey || e.altKey ? 'copy' : 'move') : 'copy';
    setDropTarget(target);
  };
  const onDropTarget = (e: DragEvent, targetDir: string) => {
    e.preventDefault();
    setDropTarget(null);
    const names = dragNames.current;
    dragNames.current = null;
    if (names) {
      if (targetDir === dir || names.some((n) => joinPath(dir, n) === targetDir)) return;
      transfer(e.ctrlKey || e.altKey ? 'copy' : 'move', names.map((n) => joinPath(dir, n)), targetDir);
    } else if (e.dataTransfer.files.length) {
      void upload(Array.from(e.dataTransfer.files), targetDir);
    }
  };

  // ---- render helpers -----------------------------------------------------
  const crumbs = useMemo(() => {
    if (!dir) return [];
    const t = tildePath(dir, home);
    const parts = t.split('/').filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let acc = '';
    for (const [i, p] of parts.entries()) {
      acc = i === 0 && p === '~' ? '~' : `${acc}/${p}`;
      out.push({ label: p === '~' ? 'Home' : p, path: acc });
    }
    if (!t.startsWith('~')) out.unshift({ label: '/', path: '/' });
    return out;
  }, [dir, home]);

  // Deep paths: keep the current folder (the end of the bar) in view.
  const crumbsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [crumbs, editingPath]);

  const pinned = prefs.pins.includes(tildePath(dir, home));
  const togglePin = () => {
    const here = tildePath(dir, home);
    updatePrefs({ pins: pinned ? prefs.pins.filter((p) => p !== here) : [...prefs.pins, here] });
  };
  const quick = [{ label: 'Shared', path: '~/shared' }, { label: 'Home', path: '~' },
    ...prefs.pins.filter((p) => p !== '~/shared' && p !== '~').map((p) => ({ label: p.split('/').pop() || p, path: p }))];

  const menuEntries = menu?.entries ?? [];
  const single = menuEntries.length === 1 ? menuEntries[0] : null;
  const anyUploading = uploads.some((u) => u.state === 'waiting' || u.state === 'sending');
  const upTotal = uploads.reduce((n, u) => n + u.size, 0);
  const upDone = uploads.reduce((n, u) => n + Math.min(u.loaded, u.size), 0);

  return (
    <div
      className="flex flex-col h-full bg-zinc-950"
      onDragOver={(e) => { if (isFileDrag(e) && !dragNames.current && !readOnly) { e.preventDefault(); setDropTarget('.'); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTarget(null); }}
      onDrop={(e) => onDropTarget(e, dir)}
    >
      {/* Header */}
      <header className="shrink-0 px-2 pt-[max(10px,env(safe-area-inset-top))] pb-2 border-b border-zinc-800 space-y-2">
        <div className="flex items-center gap-1">
          <ToolButton onClick={goBack} title="Back"><ArrowLeft className="w-5 h-5" /></ToolButton>
          <ToolButton onClick={() => listing?.parent && void load(listing.parent)} disabled={!listing?.parent} title="Up one folder">
            <ArrowUp className="w-5 h-5" />
          </ToolButton>
          {/* Path: segments, or a box to type one */}
          {editingPath !== null ? (
            <form className="flex-1 min-w-0" onSubmit={(e) => { e.preventDefault(); const p = editingPath.trim(); setEditingPath(null); if (p) void load(p); }}>
              <input
                autoFocus
                value={editingPath}
                onChange={(e) => setEditingPath(e.target.value)}
                onBlur={() => setEditingPath(null)}
                className="w-full px-2 py-1.5 text-sm font-mono bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 focus:outline-none"
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
              />
            </form>
          ) : (
            <div
              ref={crumbsRef}
              className="flex-1 min-w-0 flex items-center overflow-x-auto no-scrollbar text-sm"
              onDoubleClick={() => setEditingPath(tildePath(dir, home))}
            >
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center shrink-0">
                  {i > 0 && crumbs[i - 1].path !== '/' && <span className="px-0.5 text-zinc-600">/</span>}
                  <button
                    onClick={() => (i === crumbs.length - 1 ? setEditingPath(tildePath(dir, home)) : void load(c.path))}
                    onDragOver={(e) => onDragOverTarget(e, `crumb:${c.path}`)}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(e) => { e.stopPropagation(); onDropTarget(e, c.path); }}
                    className={`px-1.5 py-1 rounded-md whitespace-nowrap ${i === crumbs.length - 1 ? 'text-zinc-100 font-medium' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'} ${dropTarget === `crumb:${c.path}` ? 'ring-2 ring-sky-400' : ''}`}
                    title={i === crumbs.length - 1 ? 'Type a path' : `Open ${c.path}`}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
          )}
          <ToolButton onClick={togglePin} title={pinned ? 'Unpin this folder' : 'Pin this folder'} active={pinned} disabled={!dir}>
            <Star className={`w-4 h-4 ${pinned ? 'fill-amber-300 text-amber-300' : ''}`} />
          </ToolButton>
        </div>

        <div className="flex items-center gap-1">
          {searchOpen ? (
            <div className="flex-1 min-w-0 flex items-center gap-1 px-2 bg-zinc-900 border border-zinc-700 rounded-lg">
              <Search className="w-4 h-4 text-zinc-500 shrink-0" />
              <input
                ref={searchRef}
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter this folder"
                className="flex-1 min-w-0 py-1.5 bg-transparent text-sm text-zinc-100 focus:outline-none"
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
              />
              <button onClick={() => { setQuery(''); setSearchOpen(false); }} className="p-1 text-zinc-500 hover:text-zinc-200" aria-label="Close search"><X className="w-4 h-4" /></button>
            </div>
          ) : (
            <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto no-scrollbar">
              {quick.map((q) => (
                <button
                  key={q.path}
                  onClick={() => void load(q.path)}
                  className={`shrink-0 px-2.5 py-1 text-xs rounded-full border ${tildePath(dir, home) === q.path ? 'border-sky-500/60 text-sky-300 bg-sky-500/10' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
                >
                  {q.label}
                </button>
              ))}
            </div>
          )}
          {!searchOpen && <ToolButton onClick={() => setSearchOpen(true)} title="Search (/)"><Search className="w-4 h-4" /></ToolButton>}
          <div className="relative">
            <ToolButton onClick={() => setSortOpen((o) => !o)} title="Sort and show" active={sortOpen}><ArrowDownAZ className="w-4 h-4" /></ToolButton>
            {sortOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setSortOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-40 w-52 py-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl">
                  {([['name', 'Name'], ['mtime', 'Date modified'], ['size', 'Size'], ['type', 'Type']] as [SortKey, string][]).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => updatePrefs(prefs.sort === key ? { desc: !prefs.desc } : { sort: key, desc: key === 'mtime' || key === 'size' })}
                      className="flex w-full items-center justify-between px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
                    >
                      {label}
                      {prefs.sort === key && <span className="text-xs text-sky-300">{prefs.desc ? 'Newest/largest first' : 'A→Z / oldest first'}</span>}
                    </button>
                  ))}
                  <div className="my-1 border-t border-zinc-700" />
                  <button onClick={() => updatePrefs({ showHidden: !prefs.showHidden })} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700">
                    {prefs.showHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    {prefs.showHidden ? 'Hide hidden files' : `Show hidden files${hiddenCount ? ` (${hiddenCount})` : ''}`}
                  </button>
                </div>
              </>
            )}
          </div>
          <ToolButton onClick={() => updatePrefs({ view: prefs.view === 'list' ? 'grid' : 'list' })} title={prefs.view === 'list' ? 'Grid view' : 'List view'}>
            {prefs.view === 'list' ? <LayoutGrid className="w-4 h-4" /> : <List className="w-4 h-4" />}
          </ToolButton>
          <ToolButton onClick={refresh} title="Refresh (F5)"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></ToolButton>
          <div className="relative">
            <button
              onClick={() => setAddOpen((o) => !o)}
              disabled={!dir || readOnly}
              className="ml-1 flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-zinc-900 bg-zinc-100 rounded-lg active:bg-zinc-300 hover:bg-white disabled:opacity-40"
            >
              <Upload className="w-4 h-4" /> <span className="hidden sm:inline">Add</span>
            </button>
            {addOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setAddOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-40 w-48 py-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl">
                  <MenuItem icon={Upload} label="Upload files" onClick={() => { setAddOpen(false); fileInput.current?.click(); }} />
                  <MenuItem icon={FolderUp} label="Upload a folder" onClick={() => { setAddOpen(false); folderInput.current?.click(); }} />
                  {!desktop && <MenuItem icon={Camera} label="Take a photo" onClick={() => { setAddOpen(false); cameraInput.current?.click(); }} />}
                  <div className="my-1 border-t border-zinc-700" />
                  <MenuItem icon={FolderPlus} label="New folder" onClick={() => { setAddOpen(false); setDialog({ kind: 'mkdir' }); }} />
                  <MenuItem icon={FilePlus} label="New text file" onClick={() => { setAddOpen(false); setDialog({ kind: 'newfile' }); }} />
                </div>
              </>
            )}
          </div>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <input
            ref={folderInput} type="file" multiple hidden
            {...{ webkitdirectory: '', directory: '' } as Record<string, string>}
            onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }}
          />
          <input ref={cameraInput} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </div>

        {busy && (
          <div className="flex items-center gap-2 px-1 text-xs text-zinc-400">
            <span className="inline-block w-3 h-3 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" /> {busy}
          </div>
        )}
        {readOnly && <div className="px-1 text-xs text-amber-300/80">PersaLink's own settings folder — read only here.</div>}
      </header>

      {/* Paste bar */}
      {clip && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-sky-950/60 border-b border-sky-900 text-sm">
          {clip.mode === 'move' ? <Scissors className="w-4 h-4 text-sky-300" /> : <Copy className="w-4 h-4 text-sky-300" />}
          <span className="flex-1 min-w-0 truncate text-sky-100">
            {clip.mode === 'move' ? 'Moving' : 'Copying'} {clip.paths.length > 1 ? `${clip.paths.length} items` : clip.paths[0].split('/').pop()}
          </span>
          <button
            onClick={paste}
            disabled={readOnly || (clip.mode === 'move' && clip.from === dir) || !!busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-zinc-900 bg-sky-300 rounded-lg disabled:opacity-40"
          >
            <ClipboardPaste className="w-4 h-4" /> Paste here
          </button>
          <button onClick={() => setClip(null)} className="p-1.5 text-sky-200 hover:text-white" aria-label="Cancel"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Listing */}
      <div
        className={`flex-1 min-h-0 overflow-y-auto px-2 py-2 ${dropTarget === '.' ? 'ring-2 ring-inset ring-sky-500/60 bg-sky-500/5' : ''}`}
        onContextMenu={(e) => { if (e.target === e.currentTarget) showMenu(e, null); }}
        onClick={(e) => { if (e.target === e.currentTarget && desktop) setSelected(new Set()); }}
      >
        {error && <div className="px-3 py-4 text-sm text-red-400">{error}</div>}
        {!error && !loading && shown.length === 0 && (
          <div className="px-3 py-12 text-center text-sm text-zinc-600">
            {query ? `Nothing here matches "${query}"` : readOnly ? 'Empty folder' : desktop ? 'Empty folder — drop files here to upload' : 'Empty folder'}
          </div>
        )}
        {prefs.view === 'list' && shown.length > 0 && (
          <div className="hidden sm:flex items-center gap-2 px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-600">
            <span className="w-9" />
            <button className="flex-1 text-left hover:text-zinc-300" onClick={() => updatePrefs(prefs.sort === 'name' ? { desc: !prefs.desc } : { sort: 'name', desc: false })}>Name</button>
            <button className="w-28 text-right hover:text-zinc-300" onClick={() => updatePrefs(prefs.sort === 'mtime' ? { desc: !prefs.desc } : { sort: 'mtime', desc: true })}>Modified</button>
            <button className="w-20 text-right hover:text-zinc-300" onClick={() => updatePrefs(prefs.sort === 'size' ? { desc: !prefs.desc } : { sort: 'size', desc: true })}>Size</button>
            <span className="w-8" />
          </div>
        )}
        <div className={prefs.view === 'list' ? 'space-y-0.5' : 'grid gap-2 grid-cols-[repeat(auto-fill,minmax(104px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))]'}>
          {shown.map((entry) => {
            const folder = entry.type === 'dir' ? joinPath(dir, entry.name) : null;
            return (
              <EntryItem
                key={entry.name}
                entry={entry}
                view={prefs.view}
                desktop={desktop}
                selected={selected.has(entry.name)}
                showChecks={selectMode || (desktop && selected.size > 1)}
                draggable={desktop && !readOnly}
                dropActive={dropTarget === entry.name}
                thumb={thumb(entry)}
                onActivate={(e) => onRowClick(entry, e)}
                onLongPress={() => { setSelectMode(true); toggle(entry.name); }}
                onOpen={() => open(entry)}
                onMenu={(e) => showMenu(e, entry)}
                onDragStart={(e) => {
                  const names = selected.has(entry.name) ? [...selected] : [entry.name];
                  dragNames.current = names;
                  e.dataTransfer.effectAllowed = 'copyMove';
                  e.dataTransfer.setData('text/plain', names.join('\n'));
                }}
                onDragEnd={() => { dragNames.current = null; setDropTarget(null); }}
                drop={folder ? { over: (e) => onDragOverTarget(e, entry.name), leave: () => setDropTarget(null), drop: (e) => onDropTarget(e, folder) } : undefined}
              />
            );
          })}
        </div>
        {listing?.truncated && <div className="px-3 py-3 text-xs text-zinc-500">Showing the first 5,000 items.</div>}
      </div>

      {/* Uploads */}
      {uploads.length > 0 && (
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-900 px-3 py-2 text-xs space-y-1.5 max-h-40 overflow-y-auto">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-zinc-300">
              {anyUploading ? `Uploading ${uploads.filter((u) => u.state === 'done').length + 1} of ${uploads.length}` : `Uploaded ${uploads.filter((u) => u.state === 'done').length} of ${uploads.length}`}
              <span className="text-zinc-500"> · {fmtSize(upDone)} of {fmtSize(upTotal)}</span>
            </span>
            {anyUploading
              ? <button onClick={() => uploadAbort.current?.abort()} className="px-2 py-0.5 text-zinc-300 bg-zinc-800 rounded">Cancel</button>
              : <button onClick={() => setUploads([])} className="p-0.5 text-zinc-400 hover:text-zinc-200" aria-label="Close"><X className="w-4 h-4" /></button>}
          </div>
          <div className="h-1 rounded bg-zinc-800 overflow-hidden"><div className="h-full bg-sky-500 transition-[width]" style={{ width: `${upTotal ? (upDone / upTotal) * 100 : 0}%` }} /></div>
          {uploads.filter((u) => u.state === 'failed').map((u) => (
            <div key={u.name} className="text-red-400 truncate">{u.name}: {u.error}</div>
          ))}
        </div>
      )}

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 pb-[max(6px,env(safe-area-inset-bottom))] border-t border-zinc-800 bg-zinc-900">
          <button onClick={() => setSelected(new Set())} className="p-2 text-zinc-400 hover:text-zinc-100" aria-label="Clear selection"><X className="w-4 h-4" /></button>
          <span className="flex-1 min-w-0 truncate text-sm text-zinc-200">
            {selected.size} selected{selectedBytes ? <span className="text-zinc-500"> · {fmtSize(selectedBytes)}</span> : null}
          </span>
          <ToolButton onClick={() => setSelected(new Set(shown.map((e) => e.name)))} title="Select all"><Check className="w-4 h-4" /></ToolButton>
          <ToolButton onClick={() => download(selectedEntries)} title={selectedEntries.length === 1 && selectedEntries[0].type === 'file' ? 'Download' : 'Download as .zip'}><Download className="w-4 h-4" /></ToolButton>
          <ToolButton onClick={() => toClip('move', selectedEntries)} title="Move" disabled={readOnly}><FolderInput className="w-4 h-4" /></ToolButton>
          <ToolButton onClick={() => toClip('copy', selectedEntries)} title="Copy"><Copy className="w-4 h-4" /></ToolButton>
          {selectedEntries.length === 1 && <ToolButton onClick={() => setDialog({ kind: 'rename', entry: selectedEntries[0] })} title="Rename (F2)" disabled={readOnly}><Pencil className="w-4 h-4" /></ToolButton>}
          <ToolButton onClick={() => remove(selectedEntries)} title="Delete" disabled={readOnly}><Trash2 className="w-4 h-4 text-red-400" /></ToolButton>
        </div>
      )}
      {selected.size === 0 && listing && (
        <div className="shrink-0 px-3 py-1 pb-[max(4px,env(safe-area-inset-bottom))] text-[11px] text-zinc-600 border-t border-zinc-900">
          {shown.length} item{shown.length === 1 ? '' : 's'}{query ? ' matching' : ''}
          {!prefs.showHidden && hiddenCount ? ` · ${hiddenCount} hidden` : ''}
        </div>
      )}

      {/* Context menu: popover on desktop, bottom sheet on phones */}
      {menu && (
        <>
          <div className={`fixed inset-0 z-40 ${desktop ? '' : 'bg-black/40'}`} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className={`fixed z-50 py-1 bg-zinc-800 border border-zinc-700 shadow-2xl ${desktop ? 'w-56 rounded-lg' : 'inset-x-0 bottom-0 rounded-t-2xl pb-[max(8px,env(safe-area-inset-bottom))]'}`}
            style={desktop ? { left: Math.min(menu.x, window.innerWidth - 232), top: Math.min(menu.y, window.innerHeight - 380) } : undefined}
            onClickCapture={(e) => { if ((e.target as HTMLElement).closest('button:not(:disabled)')) setTimeout(() => setMenu(null), 0); }}
          >
            {menu.entries ? (
              <>
                <div className="px-3 py-2 text-xs text-zinc-400 truncate border-b border-zinc-700 mb-1">
                  {single ? single.name : `${menuEntries.length} items`}
                </div>
                {single && <MenuItem icon={single.type === 'dir' ? Folder : Eye} label="Open" onClick={() => open(single)} />}
                <MenuItem icon={Download} label={single?.type === 'file' ? 'Download' : 'Download as .zip'} onClick={() => download(menuEntries)} />
                {single && <MenuItem icon={Pencil} label="Rename" onClick={() => setDialog({ kind: 'rename', entry: single })} disabled={readOnly} />}
                <MenuItem icon={FolderInput} label="Move to…" onClick={() => toClip('move', menuEntries)} disabled={readOnly} />
                <MenuItem icon={Copy} label="Copy to…" onClick={() => toClip('copy', menuEntries)} />
                <MenuItem icon={Link2} label={menuEntries.length > 1 ? 'Copy paths' : 'Copy path'} onClick={() => void copyPaths(menuEntries)} />
                {single?.type === 'dir' && (
                  <MenuItem
                    icon={Star}
                    label={prefs.pins.includes(tildePath(joinPath(dir, single.name), home)) ? 'Unpin' : 'Pin'}
                    onClick={() => {
                      const p = tildePath(joinPath(dir, single.name), home);
                      updatePrefs({ pins: prefs.pins.includes(p) ? prefs.pins.filter((x) => x !== p) : [...prefs.pins, p] });
                    }}
                  />
                )}
                <div className="my-1 border-t border-zinc-700" />
                <MenuItem icon={Trash2} label="Delete" onClick={() => remove(menuEntries)} danger disabled={readOnly} />
              </>
            ) : (
              <>
                {clip && <MenuItem icon={ClipboardPaste} label="Paste here" onClick={paste} disabled={readOnly || (clip.mode === 'move' && clip.from === dir)} />}
                <MenuItem icon={Upload} label="Upload files" onClick={() => fileInput.current?.click()} disabled={readOnly} />
                <MenuItem icon={FolderPlus} label="New folder" onClick={() => setDialog({ kind: 'mkdir' })} disabled={readOnly} />
                <MenuItem icon={FilePlus} label="New text file" onClick={() => setDialog({ kind: 'newfile' })} disabled={readOnly} />
                <MenuItem icon={Link2} label="Copy this folder's path" onClick={() => void copyPaths([])} />
                <MenuItem icon={RefreshCw} label="Refresh" onClick={refresh} />
              </>
            )}
          </div>
        </>
      )}

      {dialog && (
        <NameDialog
          title={dialog.kind === 'mkdir' ? 'New folder' : dialog.kind === 'newfile' ? 'New text file' : `Rename ${dialog.entry.name}`}
          initial={dialog.kind === 'rename' ? dialog.entry.name : dialog.kind === 'newfile' ? 'notes.txt' : ''}
          action={dialog.kind === 'rename' ? 'Rename' : 'Create'}
          onSubmit={submitDialog}
          onCancel={() => setDialog(null)}
        />
      )}

      {viewer !== null && listing && viewerIndex >= 0 && (
        <FileViewer
          conn={conn}
          dir={dir}
          link={listing.link}
          readOnly={readOnly}
          items={viewable}
          index={viewerIndex}
          onIndex={(i) => setViewer(viewable[i]?.name ?? null)}
          onClose={() => setViewer(null)}
          onDelete={(e) => remove([e])}
          onSaved={refresh}
          notify={notify}
        />
      )}
    </div>
  );
}
