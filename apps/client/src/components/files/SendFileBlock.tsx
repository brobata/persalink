/**
 * @file SendFileBlock
 * @description The top of the Files panel: the one thing it is mostly opened
 *   for. "Send a file to <session>" uploads into ~/shared/persalink-uploads
 *   and types the path(s) into that session with a trailing space, exactly
 *   like the paperclip on a pane strip, so the next act is telling the agent
 *   about it. Under it, Recent uploads (newest first): click one to type its
 *   path into the session again. Browsing other folders sits below this.
 *   The target is the focused pane's session on desktop, the open session on
 *   a phone. On desktop the pane's own upload runs (it is mounted behind the
 *   panel); on a phone the terminal is not mounted, so the path is typed with
 *   `tmux send-keys -l` over exec.run and the session opens.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { File as FileIcon, FolderOpen, Paperclip } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useUiStore } from '../../stores/uiStore';
import { deviceKind } from '../../lib/device';
import { sendPaneCommand } from '../../lib/paneCommands';
import { shellPath, typeTextCommand } from '../../lib/inlineAnswer';
import { uploadFiles } from '../../lib/upload';
import { openSession } from '../../lib/openSession';
import { sessionTitle } from '../../lib/sessionState';
import { listFolder, fmtDate, joinPath, tildePath, type Conn, type FileEntry } from '../../lib/files';

export const UPLOADS_DIR = '~/shared/persalink-uploads';
const RECENT = 5;

interface Target { id: string; name: string; paneId: string | null }

const SEND_TAG = 'send-path';
const SEND_WAIT_MS = 8000;

/** The phone path types over exec.run, so nobody would see a failure (the
 *  session ended meanwhile): watch the result and say where the file is. */
function watchSend(name: string): void {
  const started = Date.now();
  const unsub = useAppStore.subscribe((s) => {
    const r = s.execResults[SEND_TAG];
    if (!r && Date.now() - started < SEND_WAIT_MS) return;
    unsub();
    clearTimeout(timer);
    if (!r) return;
    useAppStore.getState().clearExecResult(SEND_TAG);
    if (r.exitCode !== 0) {
      useAppStore.getState().pushNotification('error', `Could not type the path into ${name}. The file is in ${UPLOADS_DIR}.`, 'upload');
    }
  });
  const timer = setTimeout(() => unsub(), SEND_WAIT_MS);
}

/** The session a sent file goes to, or null when none is open. */
function useTarget(): Target | null {
  const sessions = useAppStore((s) => s.sessions);
  const attached = useAppStore((s) => s.attachedSession);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const panes = useLayoutStore((s) => s.panes);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const desktop = deviceKind() === 'desktop';
  if (desktop) {
    const p = panes.find((x) => x.id === focusedPaneId);
    if (!p?.sessionId || (p.serverId && p.serverId !== activeServerId)) return null;
    const s = sessions.find((x) => x.id === p.sessionId);
    return s ? { id: s.id, name: sessionTitle(s), paneId: p.id } : null;
  }
  const s = attached ? sessions.find((x) => x.id === attached.id) ?? attached : null;
  return s ? { id: s.id, name: sessionTitle(s), paneId: null } : null;
}

export function SendFileBlock({ conn, onBrowse, refreshKey }: {
  conn: Conn;
  /** Open a folder in the browser below. */
  onBrowse: (path: string) => void;
  /** Bumps when the browser below changed something (re-read the list). */
  refreshKey: number;
}) {
  const target = useTarget();
  const [recent, setRecent] = useState<{ home: string; path: string; entries: FileEntry[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const loadRecent = useCallback(async () => {
    try {
      const l = await listFolder(conn, UPLOADS_DIR);
      const files = l.entries.filter((e) => e.type === 'file' && !e.name.startsWith('.')).sort((a, b) => b.mtime - a.mtime);
      setRecent({ home: l.home, path: l.path, entries: files.slice(0, RECENT) });
    } catch {
      // No uploads folder yet: the server makes it on the first upload.
      setRecent({ home: '', path: '', entries: [] });
    }
  }, [conn]);
  useEffect(() => { void loadRecent(); }, [loadRecent, refreshKey]);

  /** Type paths into the target the same way the pane paperclip does. */
  const deliver = useCallback((paths: string[]) => {
    if (!target || paths.length === 0) return;
    const text = paths.map(shellPath).join(' ') + ' ';
    const app = useAppStore.getState();
    if (target.paneId && sendPaneCommand(target.paneId, 'insert', text)) {
      app.closeOverlay();
      useUiStore.getState().say(paths.length === 1 ? `Sent the path to ${target.name}` : `Sent ${paths.length} paths to ${target.name}`);
      return;
    }
    const cmd = typeTextCommand(target.id, text);
    if (!cmd) {
      app.pushNotification('error', `Could not type into ${target.name}. The file is in ${UPLOADS_DIR}.`, 'upload');
      return;
    }
    app.clearExecResult(SEND_TAG);
    app.execCommand(cmd, SEND_TAG);
    watchSend(target.name);
    app.closeOverlay();
    openSession(target.id, null);
  }, [target]);

  const pick = () => {
    if (!target) return;
    // Desktop: the focused pane's own paperclip (upload, paste, error toast).
    // The panel closes only once a pane took it; otherwise upload from here.
    if (target.paneId && deviceKind() === 'desktop' && sendPaneCommand(target.paneId, 'upload')) {
      useAppStore.getState().closeOverlay();
      return;
    }
    input.current?.click();
  };

  const onPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const paths = await uploadFiles(files, { serverUrl: conn.serverUrl, authToken: conn.authToken });
      if (paths.length === 0) throw new Error('the server kept none of them (too large?)');
      deliver(paths);
    } catch (err) {
      useAppStore.getState().pushNotification('error', `Upload failed: ${err instanceof Error ? err.message : err}`, 'upload');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section className="pl-send" aria-label="Send a file">
      <input ref={input} type="file" multiple className="hidden" onChange={onPicked} />
      <button type="button" className="pl-btn pri w-full justify-center" disabled={!target || busy} onClick={pick}>
        <Paperclip className="w-4 h-4" strokeWidth={1.75} />
        <span className="truncate">{busy ? 'Uploading…' : target ? `Send a file to ${target.name}` : 'Send a file to a session'}</span>
      </button>
      <p className="pl-send-note">
        {target
          ? <>Uploads to <span className="font-mono">{UPLOADS_DIR}</span> and types the path into {target.name}.</>
          : 'Open a session first; the path is typed into it.'}
      </p>

      <div className="pl-send-h">
        <span>Recent uploads</span>
        <button type="button" onClick={() => onBrowse(UPLOADS_DIR)} title={`Open ${UPLOADS_DIR}`}>
          <FolderOpen className="w-3.5 h-3.5" strokeWidth={1.75} />Show all
        </button>
      </div>
      {recent && recent.entries.length === 0 && <p className="pl-send-note">Nothing uploaded yet.</p>}
      {recent && recent.entries.length > 0 && (
        <ul className="pl-send-list">
          {recent.entries.map((f) => {
            const path = tildePath(joinPath(recent.path, f.name), recent.home);
            return (
              <li key={f.name}>
                <button
                  type="button"
                  disabled={!target}
                  onClick={() => deliver([path])}
                  title={target ? `Type ${path} into ${target.name}` : path}
                >
                  <FileIcon className="w-3.5 h-3.5 shrink-0 text-fg-3" strokeWidth={1.75} />
                  <span className="nm">{f.name}</span>
                  <span className="age">{fmtDate(f.mtime)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
