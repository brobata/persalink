/**
 * @file TerminalPane
 * @description Self-contained terminal pane for the desktop grid layout.
 *   Owns its own WebSocket, xterm.js instance, and attach/detach lifecycle so
 *   multiple panes can be live at once — each streaming a different tmux
 *   session. The single-pane mobile TerminalScreen keeps its own code path.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { ServerMessage, SessionInfo, TmuxWindowInfo } from '@persalink/shared/protocol';
import { WSClient } from '../lib/ws';
import { useAppStore } from '../stores/appStore';
import { useTerminalStyleStore, getTheme, getFontStack } from '../stores/terminalStyleStore';
import { useVoiceInput } from '../lib/voiceInput';
import { getInitialDims, saveDims } from '../lib/terminalDims';

interface TerminalPaneProps {
  paneId: string;
  paneNumber: number;
  sessionId: string | null;
  serverUrl: string;
  authToken: string;
  isFocused: boolean;
  onFocus: () => void;
  onClear: () => void;
  onPickSession: () => void;
}

function WindowTab({ w, onSelect, onRename }: {
  w: TmuxWindowInfo;
  onSelect: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(w.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    setEditName(w.name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== w.name) onRename(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={editName}
        onChange={(e) => setEditName(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitRename();
          if (e.key === 'Escape') setEditing(false);
        }}
        className="shrink-0 w-24 px-2 py-0.5 bg-zinc-800 border border-zinc-600 rounded text-[11px] text-zinc-100 outline-none"
        autoFocus
      />
    );
  }

  return (
    <button
      onClick={onSelect}
      onDoubleClick={startEditing}
      title="Double-click to rename"
      className={`shrink-0 px-2 py-0.5 text-[11px] rounded transition-colors ${
        w.active ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {w.name}
    </button>
  );
}

export function TerminalPane({
  paneId, paneNumber, sessionId, serverUrl, authToken, isFocused, onFocus, onClear, onPickSession,
}: TerminalPaneProps) {
  const [attachedSession, setAttachedSession] = useState<SessionInfo | null>(null);
  const [windows, setWindows] = useState<TmuxWindowInfo[]>([]);
  const [connState, setConnState] = useState<'connecting' | 'ready' | 'reconnecting' | 'disconnected'>('connecting');

  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WSClient | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(sessionId);
  const pendingRef = useRef<Array<{ data: string; sessionId: string }>>([]);
  const authedRef = useRef(false);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Composition state needs to be resettable from outside the xterm-mount
  // effect (on session change, on pane blur), so it lives in refs the
  // mount effect closes over.
  const compositionResetRef = useRef<(() => void) | null>(null);
  // Hold callbacks in refs so the xterm effect can stay mounted across
  // re-renders that only change parent callbacks (e.g. focus shifting).
  const onFocusRef = useRef(onFocus);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  const sendInput = useCallback((data: string) => {
    wsRef.current?.send({ type: 'session.input', data });
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    wsRef.current?.send({ type: 'session.resize', cols, rows });
  }, []);

  const voice = useVoiceInput(useCallback((text: string) => {
    sendInput(text);
  }, [sendInput]));
  useEffect(() => {
    if (!voice.error) return;
    useAppStore.getState().pushNotification('error', voice.error, 'voice');
  }, [voice.error]);

  const selectWindow = useCallback((index: number) => {
    wsRef.current?.send({ type: 'window.select', windowIndex: index });
  }, []);

  const renameWindow = useCallback((index: number, name: string) => {
    wsRef.current?.send({ type: 'window.rename', windowIndex: index, name });
  }, []);

  const renameSession = useCallback((sessionId: string, name: string) => {
    wsRef.current?.send({ type: 'session.rename', sessionId, name });
  }, []);

  const [renamingSession, setRenamingSession] = useState(false);
  const [sessionEditName, setSessionEditName] = useState('');
  const sessionNameInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const hostOnly = serverUrl.trim().replace(/^(wss?|https?):\/\//i, '');
      const scheme = window.location.protocol === 'https:' ? 'https://' : 'http://';
      const res = await fetch(`${scheme}${hostOnly}/api/upload`, {
        method: 'POST',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        body: form,
      });
      if (!res.ok) throw new Error('upload failed');
      const result = await res.json();
      sendInput(result.path);
    } catch (err) {
      console.error('[PersaLink] upload failed:', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [serverUrl, authToken, sendInput]);

  // ------------------------------------------------------------------
  // WebSocket lifecycle — one connection per pane, reused across sessions
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!serverUrl || !authToken) return;

    const hostOnly = serverUrl.trim().replace(/^(wss?|https?):\/\//i, '');
    const scheme = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const wsUrl = `${scheme}${hostOnly}`;

    const client = new WSClient({
      url: wsUrl,
      onMessage: (msg: ServerMessage) => {
        switch (msg.type) {
          case 'auth.required':
            client.send({ type: 'auth.token', token: authToken });
            break;
          case 'auth.ok': {
            authedRef.current = true;
            setConnState('ready');
            const target = sessionIdRef.current;
            if (target) {
              const lines = useTerminalStyleStore.getState().historyOnAttach;
              const t = termRef.current;
              const fallback = getInitialDims();
              client.send({
                type: 'session.attach',
                sessionId: target,
                cols: t?.cols ?? fallback.cols,
                rows: t?.rows ?? fallback.rows,
                scrollbackLines: lines,
              });
            }
            break;
          }
          case 'auth.failed':
            setConnState('disconnected');
            break;
          case 'session.attached': {
            if (msg.session.id !== sessionIdRef.current) break;
            setAttachedSession(msg.session);
            setWindows(msg.session.windows);
            const term = termRef.current;
            if (term) {
              term.reset();
              // Optional history prefill — controlled by the
              // historyOnAttach setting (0 = skip). Sequence is critical:
              //   1. Write captured plain-text history (cursor advances)
              //   2. End on a newline so the next paint starts cleanly
              //   3. Clear the visible viewport with \e[2J and home the
              //      cursor with \e[H — this preserves the scrollback
              //      buffer above but gives the incoming PTY redraw a
              //      clean slate, avoiding the ANSI/plain-text collision
              //      that produced cursor corruption before.
              if (msg.scrollback) {
                term.write(
                  msg.scrollback.endsWith('\n') ? msg.scrollback : msg.scrollback + '\n'
                );
                term.write('\x1b[2J\x1b[H');
              }
              for (const entry of pendingRef.current) {
                if (entry.sessionId === msg.session.id) term.write(entry.data);
              }
              pendingRef.current = [];
              // Force tmux to redraw at our current size. Without this, if
              // the tmux session was sized by a prior client, the screen
              // paints at the wrong dimensions and content wraps into the
              // top-left corner of the pane.
              try { fitRef.current?.fit(); } catch { /* detached */ }
              client.send({ type: 'session.resize', cols: term.cols, rows: term.rows });
            }
            break;
          }
          case 'session.output': {
            if (msg.sessionId !== sessionIdRef.current) break;
            if (termRef.current) termRef.current.write(msg.data);
            else pendingRef.current.push({ data: msg.data, sessionId: msg.sessionId });
            break;
          }
          case 'session.ended':
            if (msg.sessionId === sessionIdRef.current) {
              setAttachedSession(null);
              setWindows([]);
            }
            break;
          case 'session.detached':
            setAttachedSession(null);
            setWindows([]);
            break;
          case 'sessions.list': {
            // Pick up rename / metadata changes for the session this pane
            // is currently attached to. Without this, custom names set via
            // session.rename never reach the pane's local state.
            const current = sessionIdRef.current;
            if (!current) break;
            const updated = msg.sessions.find((s) => s.id === current);
            if (updated) setAttachedSession(updated);
            break;
          }
          case 'windows.list':
            setWindows(msg.windows);
            break;
          case 'session.scrollback':
            if (termRef.current) termRef.current.write(msg.data);
            break;
        }
      },
      onStateChange: (state) => {
        if (state === 'reconnecting') setConnState('reconnecting');
        else if (state === 'disconnected') setConnState('disconnected');
        else if (state === 'connecting') setConnState('connecting');
        // 'connected' / 'authenticated' handled via message flow
      },
    });

    wsRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      wsRef.current = null;
      authedRef.current = false;
    };
  }, [serverUrl, authToken]);

  // ------------------------------------------------------------------
  // Attach/detach when sessionId prop changes
  // ------------------------------------------------------------------
  useEffect(() => {
    const client = wsRef.current;
    if (!client || !authedRef.current) return;
    pendingRef.current = [];
    // Drop any partial-composition residue carried over from the previous
    // session — otherwise the first keystroke into the new session can
    // re-send the prior session's buffered text.
    compositionResetRef.current?.();
    if (sessionId) {
      const lines = useTerminalStyleStore.getState().historyOnAttach;
      const t = termRef.current;
      const fallback = getInitialDims();
      client.send({
        type: 'session.attach',
        sessionId,
        cols: t?.cols ?? fallback.cols,
        rows: t?.rows ?? fallback.rows,
        scrollbackLines: lines,
      });
    } else {
      client.send({ type: 'session.detach' });
      setAttachedSession(null);
      setWindows([]);
      termRef.current?.reset();
    }
  }, [sessionId]);

  // ------------------------------------------------------------------
  // xterm.js lifecycle — one terminal per pane, reused across sessions
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    const initialStyle = useTerminalStyleStore.getState();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: initialStyle.fontSize,
      fontFamily: getFontStack(initialStyle.fontFamily),
      fontWeight: initialStyle.fontWeight,
      fontWeightBold: '700',
      theme: getTheme(initialStyle.theme),
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try { term.loadAddon(new WebglAddon()); } catch { /* canvas fallback */ }

    termRef.current = term;
    fitRef.current = fit;

    // Copy: copy xterm's selection to the clipboard. The modern API works
    // on https/localhost; on insecure HTTP we fall back to a textarea +
    // execCommand('copy') trick. Trigger on mouseup/touchend so we run
    // once per selection in user-gesture context (execCommand needs that).
    const legacyCopy = (text: string): boolean => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    };
    const notify = (kind: 'info' | 'error', message: string) => {
      try {
        useAppStore.getState().pushNotification(kind, message, 'copy');
      } catch { /* store unavailable */ }
    };
    const clipboardWrite = (text: string) => {
      if (!text) return;
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
          () => notify('info', 'Copied'),
          () => {
            if (legacyCopy(text)) notify('info', 'Copied');
            else notify('error', 'Copy blocked by browser');
          },
        );
        return;
      }
      if (legacyCopy(text)) notify('info', 'Copied');
      else notify('error', 'Copy blocked by browser');
    };
    // Track "has a new selection been made since the last copy?" so a stale
    // xterm selection doesn't re-fire copy on every subsequent click. xterm
    // keeps the selection alive across clicks, so without this guard each
    // mouseup re-reads the same text and toasts "Copied" again.
    let hasFreshSelection = false;
    const selectionChangeDisposable = term.onSelectionChange(() => {
      if (term.hasSelection()) hasFreshSelection = true;
    });
    const onSelectionEnd = () => {
      if (!hasFreshSelection) return;
      hasFreshSelection = false;
      const sel = term.getSelection();
      if (sel) clipboardWrite(sel);
    };
    document.addEventListener('mouseup', onSelectionEnd);
    document.addEventListener('touchend', onSelectionEnd);

    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        sendInput(text);
      }
    };
    containerRef.current!.addEventListener('paste', onPaste as EventListener);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // Ctrl/Cmd+C: copy if there's a selection, otherwise let it through
      // as SIGINT to the terminal program. Matches VS Code terminal UX.
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && term.hasSelection()) {
        const sel = term.getSelection();
        if (sel) clipboardWrite(sel);
        e.preventDefault();
        return false;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        document.execCommand('paste');
        return false;
      }
      return true;
    });

    // ------------------------------------------------------------------
    // Input handling — guards against the textarea-accumulation bug where
    // xterm's hidden <textarea> retains value across keystrokes (Chrome IME,
    // Android GBoard/SwiftKey autocorrect/suggestions, browser autocomplete).
    // Without this, each keystroke fires onData with the FULL accumulated
    // buffer; symptom is typed text repeating itself or showing prior content
    // each new word ("hello" prints "hhehelhellhello"; suggestion taps
    // produce "hello world hello world how are").
    //
    // Strategy: always-on delta tracking. Compare each onData payload to
    // what we last forwarded — if it's a prefix-extension, send only the
    // new chars; if it's a prefix-shrink, send DELs for the removed chars;
    // otherwise treat as fresh input. Equal-length payloads bypass the
    // delta path so repeated identical keystrokes ("h","h") aren't dropped.
    // ------------------------------------------------------------------
    let composing = false;
    let sentSoFar = '';
    // Generic dedup: drop identical onData fired within 2ms — defense
    // against any path that might double-fire.
    let lastSentData = '';
    let lastSentTime = 0;

    // Watchdog against a dropped compositionend (IME quirk, app backgrounding)
    // leaving `composing` stuck true — which makes onData swallow every
    // keystroke. Blur already recovers, but a focused pane could otherwise
    // wedge until the user clicks away; this force-clears on a composing stall.
    let compositionWatchdog: ReturnType<typeof setTimeout> | null = null;
    const resetComposition = () => {
      composing = false;
      sentSoFar = '';
      lastSentData = '';
      lastSentTime = 0;
      if (compositionWatchdog) { clearTimeout(compositionWatchdog); compositionWatchdog = null; }
      // Drain any stale value sitting in the helper textarea so the next
      // burst starts from a clean slate.
      const ta = term.textarea;
      if (ta) ta.value = '';
    };
    compositionResetRef.current = resetComposition;
    const kickCompositionWatchdog = () => {
      if (compositionWatchdog) clearTimeout(compositionWatchdog);
      compositionWatchdog = setTimeout(() => { composing = false; compositionWatchdog = null; }, 1500);
    };

    const textarea = term.textarea;
    const onCompositionStart = () => { composing = true; kickCompositionWatchdog(); };
    const onCompositionUpdate = () => { kickCompositionWatchdog(); };
    const onCompositionEnd = () => {
      composing = false;
      if (compositionWatchdog) { clearTimeout(compositionWatchdog); compositionWatchdog = null; }
    };
    if (textarea) {
      textarea.addEventListener('compositionstart', onCompositionStart);
      textarea.addEventListener('compositionupdate', onCompositionUpdate);
      textarea.addEventListener('compositionend', onCompositionEnd);
      // Suppress mobile keyboard suggestions / browser autocomplete on the
      // hidden input — reduces trigger frequency for the bug above.
      textarea.setAttribute('autocomplete', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('autocapitalize', 'none');
      textarea.setAttribute('spellcheck', 'false');
    }

    const safeSend = (data: string) => {
      const now = performance.now();
      if (data === lastSentData && now - lastSentTime < 2) return;
      lastSentData = data;
      lastSentTime = now;
      sendInput(data);
    };

    term.onData((data) => {
      if (composing) return;

      if (data.length > sentSoFar.length && sentSoFar && data.startsWith(sentSoFar)) {
        // Textarea accumulated — data is prev + new chars. Send only delta.
        const delta = data.slice(sentSoFar.length);
        if (delta) safeSend(delta);
      } else if (data.length < sentSoFar.length && sentSoFar.startsWith(data)) {
        // Buffer shrank (backspace during composition / autocorrect undo) —
        // send DEL for each removed char.
        const removed = sentSoFar.length - data.length;
        for (let i = 0; i < removed; i++) safeSend('\x7f');
      } else {
        // Fresh input — equal-length payloads, prefix mismatches, mid-buffer
        // mutations, or first keystroke. Send as-is.
        safeSend(data);
      }
      sentSoFar = data;

      // Belt-and-suspenders: clear the helper textarea after every emission.
      // Setting value programmatically does NOT fire an input event (per
      // DOM spec), so this is safe and doesn't loop. Combined with the
      // delta logic above this prevents the textarea-accumulation bug
      // regardless of which keyboard/autocorrect path got us here.
      const ta = term.textarea;
      if (ta && ta.value !== '') ta.value = '';
    });

    // Focus tracking — mark pane focused on user interaction.
    // Use the ref so identity changes from the parent don't rebuild the term.
    // Reset composition on (re)focus too, not just blur — guarantees a pane
    // that wedged while focused becomes typable again the moment it's focused.
    const focusHandler = () => { resetComposition(); onFocusRef.current(); };
    // Blur clears composition state so the next time this pane is focused
    // and typed into, the textarea doesn't replay accumulated text.
    const blurHandler = () => resetComposition();
    term.textarea?.addEventListener('focus', focusHandler);
    term.textarea?.addEventListener('blur', blurHandler);

    // Gate the first fit on the container actually having a non-zero size.
    // Fitting synchronously at mount (before flex/grid layout settles) can
    // produce 80x24 defaults against a 0-width box, pinning tmux to the
    // wrong dimensions for the session.
    let lastCols = 0;
    let lastRows = 0;
    const doFit = () => {
      try { fit.fit(); } catch { /* may fail if detached */ }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        sendResize(term.cols, term.rows);
        saveDims(term.cols, term.rows);
      }
    };
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return;
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      resizeDebounceRef.current = setTimeout(doFit, 80);
    });
    ro.observe(containerRef.current);

    // Poll fit for the first 2s. The first RO event may fire before the
    // xterm renderer has measured its cell size (WebGL + custom monospace
    // font), which would pin fit() to 80x24. Polling catches that window.
    const settle = setInterval(doFit, 200);
    const stopSettle = setTimeout(() => clearInterval(settle), 2000);

    // Re-fit once fonts are ready — cell metrics change when the fallback
    // font is swapped for Cascadia Code / JetBrains Mono.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => doFit()).catch(() => {});
    }

    // Live-apply user style changes (font family/size/weight, theme).
    // Any change that affects cell metrics triggers a refit + resize.
    const unsubStyle = useTerminalStyleStore.subscribe((next, prev) => {
      const metricsChanged =
        next.fontFamily !== prev.fontFamily ||
        next.fontSize !== prev.fontSize ||
        next.fontWeight !== prev.fontWeight;
      term.options.fontFamily = getFontStack(next.fontFamily);
      term.options.fontSize = next.fontSize;
      term.options.fontWeight = next.fontWeight;
      term.options.theme = getTheme(next.theme);
      if (metricsChanged) {
        // Give xterm a frame to re-measure its cell before refitting
        requestAnimationFrame(() => doFit());
      }
    });

    return () => {
      unsubStyle();
      ro.disconnect();
      clearInterval(settle);
      clearTimeout(stopSettle);
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      containerRef.current?.removeEventListener('paste', onPaste as EventListener);
      document.removeEventListener('mouseup', onSelectionEnd);
      document.removeEventListener('touchend', onSelectionEnd);
      selectionChangeDisposable.dispose();
      term.textarea?.removeEventListener('focus', focusHandler);
      term.textarea?.removeEventListener('blur', blurHandler);
      if (textarea) {
        textarea.removeEventListener('compositionstart', onCompositionStart);
        textarea.removeEventListener('compositionupdate', onCompositionUpdate);
        textarea.removeEventListener('compositionend', onCompositionEnd);
      }
      if (compositionWatchdog) clearTimeout(compositionWatchdog);
      compositionResetRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Mount-once: sendInput/sendResize are stable useCallbacks and onFocus is
    // read through a ref. Rebuilding xterm on parent re-render would clear the
    // scrollback and drop the live attach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  // Custom session names (set via double-click rename) come back from the
  // server in attachedSession.name and should win over the profile name —
  // otherwise multi-instance panes can't be visually distinguished.
  const label = attachedSession?.name || attachedSession?.profileName || null;

  const startSessionRename = () => {
    if (!attachedSession) return;
    setSessionEditName(label || '');
    setRenamingSession(true);
    setTimeout(() => sessionNameInputRef.current?.select(), 0);
  };
  const commitSessionRename = () => {
    if (!attachedSession) { setRenamingSession(false); return; }
    const trimmed = sessionEditName.trim();
    if (trimmed && trimmed !== label) {
      renameSession(attachedSession.id, trimmed);
    }
    setRenamingSession(false);
  };
  const focusRing = isFocused ? 'ring-1 ring-zinc-500' : 'ring-1 ring-transparent';

  return (
    <div
      className={`flex flex-col h-full min-w-0 bg-[#09090b] rounded overflow-hidden ${focusRing}`}
      onMouseDown={onFocus}
    >
      {/* Pane header */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 bg-zinc-900/80 border-b border-zinc-800 text-xs">
        <span
          className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-semibold transition-colors ${
            isFocused ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-800 text-zinc-500'
          }`}
          title={`Pane ${paneNumber}`}
        >
          {paneNumber}
        </span>
        {label ? (
          <>
            {renamingSession ? (
              <input
                ref={sessionNameInputRef}
                value={sessionEditName}
                onChange={(e) => setSessionEditName(e.target.value)}
                onBlur={commitSessionRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitSessionRename();
                  if (e.key === 'Escape') setRenamingSession(false);
                }}
                className="flex-1 min-w-0 px-1.5 py-0.5 bg-zinc-800 border border-zinc-600 rounded text-xs text-zinc-100 outline-none"
                autoFocus
              />
            ) : (
              <span
                className="truncate flex-1 text-zinc-300 cursor-text"
                onDoubleClick={startSessionRename}
                title="Double-click to rename"
              >
                {label}
              </span>
            )}
            {connState === 'reconnecting' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] text-yellow-500 bg-yellow-500/10">reconnecting</span>
            )}
            {connState === 'disconnected' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] text-red-400 bg-red-500/10">offline</span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,.pdf,.txt,.log,.json,.csv,.zip,.tar,.gz"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors"
              title="Upload file"
            >
              {uploading ? (
                <span className="w-3.5 h-3.5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin inline-block" />
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              )}
            </button>
            <button
              onClick={onClear}
              className="px-1.5 py-0.5 text-zinc-600 hover:text-zinc-300 transition-colors"
              title="Detach session from pane"
            >
              &times;
            </button>
          </>
        ) : (
          <span className="text-zinc-600 flex-1">
            {connState === 'connecting' && 'Connecting...'}
            {connState === 'reconnecting' && 'Reconnecting...'}
            {connState === 'disconnected' && 'Disconnected'}
            {connState === 'ready' && 'Empty'}
          </span>
        )}
      </div>

      {/* Window tabs — when session has multiple windows */}
      {windows.length > 1 && (
        <div className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 bg-zinc-900/40 border-b border-zinc-800/50 overflow-x-auto">
          {windows.map((w) => (
            <WindowTab
              key={w.index}
              w={w}
              onSelect={() => selectWindow(w.index)}
              onRename={(name) => renameWindow(w.index, name)}
            />
          ))}
        </div>
      )}

      {/* Terminal area (empty-state overlay when no session) */}
      <div className="flex-1 min-h-0 relative" onClick={() => termRef.current?.focus()}>
        <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
        {attachedSession && voice.isSupported && (
          <button
            // onMouseDown preventDefault stops the browser from moving focus
            // from xterm's textarea to the button. Without this, after
            // tapping the mic once, xterm never sees keypresses again —
            // including Ctrl+C, which silently broke the "select + copy"
            // workflow on desktop.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { voice.toggle(); termRef.current?.focus(); }}
            className={`absolute right-3 bottom-3 z-10 w-10 h-10 rounded-full shadow-lg flex items-center justify-center transition-colors ${
              voice.isListening
                ? 'bg-red-500 text-white animate-pulse'
                : 'bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700'
            }`}
            title={voice.isListening ? 'Stop dictation' : 'Start dictation'}
            aria-label={voice.isListening ? 'Stop dictation' : 'Start dictation'}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
            </svg>
          </button>
        )}
        {!attachedSession && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/95 pointer-events-auto">
            <button
              onClick={onPickSession}
              className="px-4 py-2 text-xs text-zinc-400 border border-dashed border-zinc-700 rounded hover:border-zinc-500 hover:text-zinc-200 transition-colors"
            >
              Pick a session for this pane
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
