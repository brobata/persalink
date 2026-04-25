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
import { useTerminalStyleStore, getTheme, getFontStack } from '../stores/terminalStyleStore';

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

  const selectWindow = useCallback((index: number) => {
    wsRef.current?.send({ type: 'window.select', windowIndex: index });
  }, []);

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
              client.send({ type: 'session.attach', sessionId: target, scrollbackLines: lines });
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
      client.send({ type: 'session.attach', sessionId, scrollbackLines: lines });
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

    // Paste
    const clipboardWrite = (text: string) => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    };
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) clipboardWrite(sel);
    });

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
      if (e.ctrlKey && e.key === 'v') {
        document.execCommand('paste');
        return false;
      }
      return true;
    });

    // ------------------------------------------------------------------
    // Input handling — guards against the textarea-accumulation bug where
    // xterm's hidden <textarea> retains value across keystrokes (Chrome IME,
    // Android GBoard/SwiftKey, browser autocomplete). Without this, each
    // keystroke fires onData with the FULL accumulated buffer, the server
    // echoes everything, and the user sees the text plus the new char each
    // time. Symptom: "hello" prints "hhehelhellhello".
    // ------------------------------------------------------------------
    let composing = false;
    let justComposed = false;
    let compositionSent = '';
    let compositionResetTimer: ReturnType<typeof setTimeout> | null = null;
    // Generic dedup: drop identical onData fired within 2ms — defense
    // against any other path that might double-fire.
    let lastSentData = '';
    let lastSentTime = 0;

    const resetComposition = () => {
      composing = false;
      justComposed = false;
      compositionSent = '';
      lastSentData = '';
      lastSentTime = 0;
      if (compositionResetTimer) {
        clearTimeout(compositionResetTimer);
        compositionResetTimer = null;
      }
      // Drain any stale value sitting in the helper textarea so the next
      // composition starts from a clean slate.
      const ta = term.textarea;
      if (ta) ta.value = '';
    };
    compositionResetRef.current = resetComposition;

    const textarea = term.textarea;
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => { composing = false; justComposed = true; };
    if (textarea) {
      textarea.addEventListener('compositionstart', onCompositionStart);
      textarea.addEventListener('compositionend', onCompositionEnd);
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

      if (justComposed) {
        justComposed = false;
        if (compositionSent && data.startsWith(compositionSent)) {
          // Textarea accumulated — data is prev + new chars. Send only delta.
          const delta = data.slice(compositionSent.length);
          compositionSent = data;
          if (delta) safeSend(delta);
        } else if (compositionSent && compositionSent.startsWith(data)) {
          // Shrunk (backspace during composition) — send DEL for removed chars.
          const removed = compositionSent.length - data.length;
          compositionSent = data;
          for (let i = 0; i < removed; i++) safeSend('\x7f');
        } else {
          // First keystroke or textarea was cleared — send as-is.
          compositionSent = data;
          safeSend(data);
        }
        if (compositionResetTimer) clearTimeout(compositionResetTimer);
        compositionResetTimer = setTimeout(() => { compositionSent = ''; }, 1500);
        return;
      }

      // Plain key path. Reset composition tracking so the next composition
      // burst starts fresh, otherwise prior composition residue interferes.
      compositionSent = '';
      safeSend(data);
    });

    // Focus tracking — mark pane focused on user interaction.
    // Use the ref so identity changes from the parent don't rebuild the term.
    const focusHandler = () => onFocusRef.current();
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
      if (compositionResetTimer) clearTimeout(compositionResetTimer);
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      containerRef.current?.removeEventListener('paste', onPaste as EventListener);
      term.textarea?.removeEventListener('focus', focusHandler);
      term.textarea?.removeEventListener('blur', blurHandler);
      if (textarea) {
        textarea.removeEventListener('compositionstart', onCompositionStart);
        textarea.removeEventListener('compositionend', onCompositionEnd);
      }
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
  const label = attachedSession?.profileName || attachedSession?.name || null;
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
            <span className="truncate flex-1 text-zinc-300">{label}</span>
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
            <button
              key={w.index}
              onClick={() => selectWindow(w.index)}
              className={`shrink-0 px-2 py-0.5 text-[11px] rounded transition-colors ${
                w.active ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {w.name}
            </button>
          ))}
        </div>
      )}

      {/* Terminal area (empty-state overlay when no session) */}
      <div className="flex-1 min-h-0 relative" onClick={() => termRef.current?.focus()}>
        <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
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
