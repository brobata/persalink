import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useAppStore } from '../stores/appStore';
import { useVoiceInput } from '../lib/voiceInput';
import { saveDims } from '../lib/terminalDims';
import type { Profile, SessionInfo } from '@persalink/shared/protocol';

// Soft-keyboard helper: keys absent from mobile keyboards but essential
// for terminal use (Esc, arrows, Tab, common Ctrl combos). Each entry
// maps a label to the byte sequence sent on tap.
const TERMINAL_KEYS: Array<{ label: string; seq: string }> = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '⇧Tab', seq: '\x1b[Z' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '^L', seq: '\x0c' },
  { label: '^R', seq: '\x12' },
  { label: 'PgUp', seq: '\x1b[5~' },
  { label: 'PgDn', seq: '\x1b[6~' },
  { label: 'Home', seq: '\x1b[H' },
  { label: 'End', seq: '\x1b[F' },
];

function TerminalKeyBar({ sendInput }: { sendInput: (data: string) => void }) {
  return (
    <div
      className="shrink-0 flex gap-1 px-2 py-1.5 bg-zinc-900 border-t border-zinc-800 overflow-x-auto"
      style={{ scrollbarWidth: 'none' }}
    >
      {TERMINAL_KEYS.map((k) => (
        <button
          key={k.label}
          onPointerDown={(e) => {
            // Keep terminal focus so the soft keyboard stays up between taps.
            e.preventDefault();
            sendInput(k.seq);
          }}
          className="shrink-0 min-w-[44px] px-2 py-2 text-xs font-mono bg-zinc-800 text-zinc-200 rounded-md active:bg-zinc-600 transition-colors select-none"
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

function WindowTab({ w, windowCount }: { w: { index: number; name: string; active: boolean }; windowCount: number }) {
  const { selectWindow, killWindow, renameWindow } = useAppStore();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(w.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startEditing = () => {
    setEditName(w.name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== w.name) {
      renameWindow(w.index, trimmed);
    }
    setEditing(false);
  };

  const onPointerDown = () => {
    longPressTimer.current = setTimeout(startEditing, 600);
  };
  const onPointerUp = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  return (
    <div
      className={`shrink-0 flex items-center gap-0.5 rounded-lg transition-colors ${
        w.active ? 'bg-zinc-700' : ''
      }`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-20 px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-xs text-zinc-100 outline-none"
          autoFocus
        />
      ) : (
        <button
          onClick={() => selectWindow(w.index)}
          onDoubleClick={startEditing}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={`px-3 py-2 text-sm transition-colors ${
            w.active ? 'text-zinc-100' : 'text-zinc-500 active:text-zinc-300'
          }`}
        >
          {w.name}
        </button>
      )}
      {windowCount > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); killWindow(w.index); }}
          className="px-1 py-1 text-zinc-600 active:text-red-400 transition-colors text-xs mr-0.5"
          title="Close tab"
        >
          &times;
        </button>
      )}
    </div>
  );
}

function TabPicker({ onClose }: { onClose: () => void }) {
  const { profiles, sessions, createSession } = useAppStore();

  const grouped = useMemo(() => {
    const groups = new Map<string, Profile[]>();
    for (const p of profiles) {
      const g = p.group || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(p);
    }
    return groups;
  }, [profiles]);

  const handlePick = (profile: Profile) => {
    createSession(profile.id);
    // onClose is handled by store (showTabPicker set to false on attach)
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div
        className="w-full max-h-[70vh] bg-zinc-900 border-t border-zinc-700 rounded-t-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-zinc-900 px-4 pt-3 pb-2 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-300">Open in new tab</span>
          <button onClick={onClose} className="px-2 py-1 text-zinc-500 text-sm">Cancel</button>
        </div>
        <div className="px-4 py-3 space-y-4">
          {Array.from(grouped.entries()).map(([group, profs]) => (
            <div key={group}>
              <div className="text-[11px] font-semibold text-zinc-600 uppercase tracking-wider mb-1.5">{group}</div>
              <div className="space-y-1">
                {profs.map((p) => {
                  const isLive = sessions.some(s => s.profileId === p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => handlePick(p)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg active:bg-zinc-800 transition-colors text-left"
                    >
                      <span className="text-base shrink-0">{p.icon || '\uD83D\uDCC2'}</span>
                      <span className="flex-1 text-sm truncate">{p.name}</span>
                      {isLive && <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />}
                      {p.color && (
                        <div className="w-1.5 h-4 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Quick session switcher — a bottom sheet of live sessions with their attention
// badges, so you can hop between running agents without going home.
function SessionSwitcher({ sessions, currentId, onPick, onNew, onClose }: {
  sessions: SessionInfo[];
  currentId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div
        className="w-full max-h-[70vh] bg-zinc-900 border-t border-zinc-700 rounded-t-2xl overflow-y-auto pb-[env(safe-area-inset-bottom)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-zinc-900 px-4 pt-3 pb-2 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-300">Switch session</span>
          <button onClick={onNew} className="text-xs text-emerald-400 active:text-emerald-300">+ New</button>
        </div>
        <div className="px-2 py-2 space-y-0.5">
          {sessions.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-zinc-600">No live sessions</div>
          )}
          {sessions.map((s) => {
            const active = s.id === currentId;
            return (
              <button
                key={s.id}
                onClick={() => { onPick(s.id); onClose(); }}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left transition-colors ${active ? 'bg-zinc-800' : 'active:bg-zinc-800/60'}`}
              >
                <span className="text-base shrink-0">{s.profileIcon || '🖥️'}</span>
                <span className="flex-1 min-w-0 truncate text-sm text-zinc-100">{s.name || s.profileName || s.id}</span>
                {s.attention === 'working' && <span className="shrink-0 text-[10px] text-sky-300">working…</span>}
                {s.attention === 'waiting' && <span className="shrink-0 text-[10px] font-semibold text-amber-300 bg-amber-500/15 px-1.5 py-0.5 rounded-full">needs you</span>}
                {s.attention === 'error' && <span className="shrink-0 w-2 h-2 rounded-full bg-red-500" />}
                {s.unseen && s.attention !== 'waiting' && s.attention !== 'error' && <span className="shrink-0 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
                {active && <span className="shrink-0 text-[10px] text-zinc-500">current</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function TerminalScreen({ sidebarVisible = false }: { sidebarVisible?: boolean }) {
  const {
    attachedSession, sendInput, exitScroll, resize, detachSession, killSession,
    initialScrollback, windows, selectWindow, createWindow, serverUrl, authToken,
    sessions, activeTabId, switchTab, closeTab, showTabPicker, setShowTabPicker, getTabs,
    attachSession,
  } = useAppStore();

  const tabs = useMemo(() => getTabs(), [sessions]);

  const [uploading, setUploading] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  // True when the user has scrolled the pane up (possibly into tmux copy-mode);
  // surfaces the "jump to live" button. Typing auto-exits copy-mode server-side.
  const [scrolledUp, setScrolledUp] = useState(false);
  const [showKeyBar, setShowKeyBar] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('persalink-show-keybar') === 'true';
  });
  const toggleKeyBar = () => {
    setShowKeyBar((v) => {
      const next = !v;
      try { localStorage.setItem('persalink-show-keybar', String(next)); } catch { /* private mode */ }
      return next;
    });
  };
  const voice = useVoiceInput(useCallback((text: string) => {
    sendInput(text);
  }, [sendInput]));
  useEffect(() => {
    if (!voice.error) return;
    useAppStore.getState().pushNotification('error', voice.error, 'voice');
  }, [voice.error]);

  const [selectText, setSelectText] = useState<string | null>(null);
  const openSelectText = () => {
    const term = terminalRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const lines: string[] = [];
    // Include scrollback + viewport. baseY = first scrollback row, length =
    // total rows (scrollback + viewport).
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    setSelectText(lines.join('\n').replace(/\n+$/, ''));
  };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOutputRef = useRef<Array<{ data: string; sessionId: string }>>([]);
  const sessionIdRef = useRef<string | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const hostOnly = serverUrl.trim().replace(/^(wss?|https?):\/\//i, '');
      const scheme = window.location.protocol === 'https:' ? 'https://' : 'http://';
      const url = `${scheme}${hostOnly}`;

      const res = await fetch(`${url}/api/upload`, {
        method: 'POST',
        headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
        body: formData,
      });

      if (!res.ok) throw new Error('Upload failed');

      const result = await res.json();
      // Paste the file path into the terminal
      sendInput(result.path);
    } catch (err) {
      console.error('[PersaLink] Upload failed:', err);
    } finally {
      setUploading(false);
      // Reset input so same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Handle output events — only write if sessionId matches, otherwise buffer
  const handleOutput = useCallback((e: Event) => {
    const { data, sessionId } = (e as CustomEvent).detail;
    if (terminalRef.current && sessionId === sessionIdRef.current) {
      terminalRef.current.write(data);
    } else {
      pendingOutputRef.current.push({ data, sessionId });
    }
  }, []);

  const handleScrollback = useCallback((e: Event) => {
    const data = (e as CustomEvent).detail;
    if (terminalRef.current) {
      terminalRef.current.write(data);
    }
  }, []);

  // Register output listeners once — no gap during session switches
  useEffect(() => {
    window.addEventListener('persalink:output', handleOutput);
    window.addEventListener('persalink:scrollback', handleScrollback);
    return () => {
      window.removeEventListener('persalink:output', handleOutput);
      window.removeEventListener('persalink:scrollback', handleScrollback);
    };
  }, [handleOutput, handleScrollback]);

  useEffect(() => {
    if (!termRef.current) return;

    // Clear stale terminal ref; keep buffer (may have output for this session)
    terminalRef.current = null;
    sessionIdRef.current = attachedSession?.id ?? null;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
      theme: {
        background: '#09090b',
        foreground: '#fafafa',
        cursor: '#fafafa',
        selectionBackground: 'rgba(255, 255, 255, 0.2)',
        black: '#18181b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#fafafa',
        brightBlack: '#71717a',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(termRef.current);

    // Try WebGL, fall back gracefully
    try {
      term.loadAddon(new WebglAddon());
    } catch { /* canvas fallback */ }

    fitAddon.fit();

    // Send initial size to server
    resize(term.cols, term.rows);
    saveDims(term.cols, term.rows);

    // NOTE: Don't write initialScrollback here. The PTY bridge (tmux attach)
    // redraws the full screen with proper ANSI escape sequences. Writing the
    // plain-text scrollback first causes double-rendering and cursor corruption.

    // Flush output that arrived before terminal was ready, filtered by session
    terminalRef.current = term;
    if (pendingOutputRef.current.length > 0) {
      const targetId = sessionIdRef.current;
      for (const entry of pendingOutputRef.current) {
        if (entry.sessionId === targetId) {
          term.write(entry.data);
        }
      }
      pendingOutputRef.current = [];
    }

    // Auto-copy on select. Modern API works on https/localhost; insecure
    // HTTP falls back to execCommand('copy') via a temp textarea. Trigger
    // on mouseup/touchend so it runs once per selection in user-gesture
    // context (execCommand needs that).
    const legacyCopy = (text: string): boolean => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
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

    // Paste via browser paste event (works on HTTP)
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        sendInput(text);
      }
    };
    termRef.current!.addEventListener('paste', onPaste as EventListener);

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

    // Textarea-accumulation guard for Android keyboards (GBoard, SwiftKey
    // autocorrect/suggestions), browser autocomplete, and IME composition.
    // xterm's hidden textarea retains value across keystrokes in those
    // paths, and onData fires with the FULL accumulated buffer each time —
    // typed text repeats itself or shows prior content on each new word.
    //
    // Strategy: always-on delta tracking. Each onData payload is compared
    // to what we last forwarded; if it's a prefix-extension we send only
    // the new chars, if a prefix-shrink we send DELs, otherwise it's
    // treated as fresh input. Equal-length payloads bypass the delta path
    // so repeated identical keystrokes ("h","h") aren't dropped.
    let composing = false;
    let sentSoFar = '';
    // Composition wedge guard. Android IMEs (GBoard/SwiftKey), the voice path,
    // and app-backgrounding mid-word can DROP the compositionend event. With
    // `if (composing) return` in onData below, a stuck `composing=true` then
    // silently swallows EVERY subsequent keystroke — the "I can't type
    // anything" hang, with no recovery on mobile (the session looks alive
    // because output is a separate path). Two safety nets:
    //   1. Watchdog — force-clear if composition goes quiet for 1.5s (kicked
    //      on each compositionupdate so genuine long composing isn't cut off).
    //   2. focus/blur — always reset on (re)focus so tapping the terminal
    //      reliably recovers a wedged session.
    let compositionWatchdog: ReturnType<typeof setTimeout> | null = null;
    const clearComposing = () => {
      composing = false;
      if (compositionWatchdog) { clearTimeout(compositionWatchdog); compositionWatchdog = null; }
    };
    const kickWatchdog = () => {
      if (compositionWatchdog) clearTimeout(compositionWatchdog);
      compositionWatchdog = setTimeout(clearComposing, 1500);
    };
    const textarea = termRef.current!.querySelector('textarea');
    if (textarea) {
      textarea.addEventListener('compositionstart', () => { composing = true; kickWatchdog(); });
      textarea.addEventListener('compositionupdate', kickWatchdog);
      textarea.addEventListener('compositionend', clearComposing);
      // A (re)focus must always yield a typable terminal — clear any stuck
      // composition and reset the delta tracker so a wedged session recovers.
      textarea.addEventListener('focus', () => { clearComposing(); sentSoFar = ''; });
      textarea.addEventListener('blur', () => { clearComposing(); sentSoFar = ''; });
      // Suppress mobile keyboard suggestions / browser autocomplete on the
      // hidden input — reduces trigger frequency for the bug above.
      textarea.setAttribute('autocomplete', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('autocapitalize', 'none');
      textarea.setAttribute('spellcheck', 'false');
    }

    term.onData((data) => {
      if (composing) return;

      // Real typing arrives via onData (touch-scroll is a separate path), so a
      // keystroke means the user is back at work — hide the jump button. The
      // server cancels copy-mode for printable input on its side.
      setScrolledUp(false);

      if (data.length > sentSoFar.length && sentSoFar && data.startsWith(sentSoFar)) {
        const delta = data.slice(sentSoFar.length);
        if (delta) sendInput(delta);
      } else if (data.length < sentSoFar.length && sentSoFar.startsWith(data)) {
        const removed = sentSoFar.length - data.length;
        for (let i = 0; i < removed; i++) sendInput('\x7f');
      } else {
        sendInput(data);
      }
      sentSoFar = data;

      // Clear xterm's helper textarea after every emission so the next
      // keystroke can't read accumulated content. Setting .value
      // programmatically doesn't fire input events (per DOM spec).
      if (textarea && textarea.value !== '') textarea.value = '';
    });

    fitAddonRef.current = fitAddon;

    // One-time hint when the user tries to scroll back in an alt-screen
    // app (Claude Code, vim, less). xterm has no scrollback for alt-screen;
    // tmux forwards wheel events to the inner app which usually doesn't
    // map them to history navigation, so nothing visible happens. Without
    // this hint the user just thinks scrolling is broken.
    let altScreenWarned = false;
    const maybeWarnAltScreenScroll = () => {
      if (altScreenWarned) return;
      altScreenWarned = true;
      try {
        useAppStore.getState().pushNotification(
          'info',
          'Scrollback is owned by this app — exit it to scroll the shell history.',
          'scrollback',
        );
      } catch { /* store unavailable */ }
    };

    // Touch scroll for mobile — slow drags scroll 1:1, fast flicks add
    // momentum that decays over time (native iOS/Android feel).
    //
    // Routing depends on buffer mode:
    //   normal buffer  → term.scrollLines() walks xterm's local scrollback.
    //   alternate buffer (tmux/vim/less/Claude TUI) → xterm has no scrollback
    //     for alt-screen, so we synthesize SGR mouse-wheel events and send
    //     them to tmux (mouse mode is enabled server-side). tmux then either
    //     enters copy-mode (outer scrollback) or forwards to the inner app
    //     if the inner app requested mouse tracking.
    let touchStartY = 0;
    let lastMoveY = 0;
    let lastMoveTime = 0;
    let scrollAccum = 0;
    let velocity = 0; // px/ms, positive = swipe up = scroll forward
    let momentumRaf: number | null = null;
    const LINE_PX = 18;
    const FRICTION_PER_16MS = 0.94; // slightly less than 1 → exponential decay
    const STOP_THRESHOLD_PX_PER_MS = 0.04; // stop momentum below this
    const FLING_THRESHOLD_PX_PER_MS = 0.25; // ignore stationary lifts
    const container = termRef.current;

    const applyScroll = (lines: number) => {
      if (lines === 0) return;
      if (term.buffer.active.type === 'alternate') {
        // SGR mouse encoding: ESC [ < Cb ; Cx ; Cy M  (press)
        // Cb 64 = wheel up, Cb 65 = wheel down. Cx/Cy are 1-indexed cell
        // coordinates; tmux ignores them for wheel events but they must
        // be present and non-zero.
        //
        // Batch the sequence into a single sendInput. A fast flick used to
        // produce one WS message per line (50+ for a hard fling), giving
        // the inner app a long input stream to chew through that competed
        // with streaming output and showed up as visible scroll lag.
        const code = lines < 0 ? 64 : 65;
        const seq = `\x1b[<${code};1;1M`;
        sendInput(seq.repeat(Math.abs(lines)));
        maybeWarnAltScreenScroll();
        // alt-screen owns its buffer, so we can't tell when we're back at the
        // bottom — surface the jump button on any up-scroll and clear it when
        // the user types (server auto-exits) or taps it.
        if (lines < 0) setScrolledUp(true);
      } else {
        term.scrollLines(lines);
        const buf = term.buffer.active;
        setScrolledUp(buf.viewportY < buf.baseY);
      }
    };

    const cancelMomentum = () => {
      if (momentumRaf !== null) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = null;
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      cancelMomentum();
      touchStartY = e.touches[0].clientY;
      lastMoveY = touchStartY;
      lastMoveTime = performance.now();
      scrollAccum = 0;
      velocity = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const now = performance.now();
      const y = e.touches[0].clientY;
      const dy = lastMoveY - y; // positive when finger moves up = scroll content up
      const dt = Math.max(1, now - lastMoveTime);
      // Smooth velocity with EMA so a single jittery sample doesn't dominate.
      velocity = velocity * 0.7 + (dy / dt) * 0.3;
      lastMoveY = y;
      lastMoveTime = now;

      scrollAccum += dy;
      const lines = Math.trunc(scrollAccum / LINE_PX);
      if (lines !== 0) {
        scrollAccum -= lines * LINE_PX;
        applyScroll(lines);
      }
    };
    const onTouchEnd = () => {
      // If the finger was essentially stopped before lift, no fling.
      // Stale velocity from earlier in the gesture also gets dropped if
      // the last few ms were quiet (touchmove not fired recently).
      const idleSinceLastMove = performance.now() - lastMoveTime;
      if (idleSinceLastMove > 80 || Math.abs(velocity) < FLING_THRESHOLD_PX_PER_MS) {
        velocity = 0;
        return;
      }

      let lastFrame = performance.now();
      const tick = () => {
        const now = performance.now();
        const dt = now - lastFrame;
        lastFrame = now;
        // Decay velocity proportional to elapsed time, normalized to 16ms frames.
        velocity *= Math.pow(FRICTION_PER_16MS, dt / 16.667);
        scrollAccum += velocity * dt;
        const lines = Math.trunc(scrollAccum / LINE_PX);
        if (lines !== 0) {
          scrollAccum -= lines * LINE_PX;
          applyScroll(lines);
        }
        if (Math.abs(velocity) > STOP_THRESHOLD_PX_PER_MS) {
          momentumRaf = requestAnimationFrame(tick);
        } else {
          velocity = 0;
          momentumRaf = null;
        }
      };
      momentumRaf = requestAnimationFrame(tick);
    };
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });

    // Handle resize — debounced, and only refit if the grid size actually changes.
    // xterm snaps to whole character cells, so a 1-2px jitter (e.g. tab bar
    // overflow recalculating) would drop a row then re-add it, causing flicker.
    //
    // 250ms debounce is tuned for Android keyboard animations (~200-400ms).
    // Shorter values fired fit() mid-animation at an intermediate size, then
    // again at the final size — two tmux redraws per keyboard event, which
    // interleaved with streaming output and looked like content "jumbling."
    let lastCols = term.cols;
    let lastRows = term.rows;
    const doFit = () => {
      fitAddon.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        resize(term.cols, term.rows);
        saveDims(term.cols, term.rows);
      }
    };
    const RESIZE_DEBOUNCE_MS = 250;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(doFit, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(termRef.current);

    // visualViewport is the authoritative signal for keyboard show/hide on
    // Android (with `interactive-widget=resizes-content` in the viewport
    // meta). It fires *after* the keyboard animation completes, giving us a
    // clean "now do the fit" trigger without waiting for ResizeObserver
    // jitter to settle. Falls back gracefully if the API isn't supported.
    const onViewportResize = () => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(doFit, RESIZE_DEBOUNCE_MS);
    };
    window.visualViewport?.addEventListener('resize', onViewportResize);

    // Re-fit after layout settles — triple pass: immediate rAF, delayed rAF,
    // and a timer to catch slow CSS transitions or conditional bar changes.
    requestAnimationFrame(() => requestAnimationFrame(doFit));
    setTimeout(doFit, 200);

    // Auto-focus terminal after mount + any pending click events resolve.
    requestAnimationFrame(() => term.focus());
    setTimeout(() => term.focus(), 150);

    return () => {
      cancelMomentum();
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('paste', onPaste as EventListener);
      document.removeEventListener('mouseup', onSelectionEnd);
      document.removeEventListener('touchend', onSelectionEnd);
      selectionChangeDisposable.dispose();
      resizeObserver.disconnect();
      window.visualViewport?.removeEventListener('resize', onViewportResize);
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      if (compositionWatchdog) clearTimeout(compositionWatchdog);
      terminalRef.current = null;
      term.dispose();
    };
  }, [attachedSession?.id]);

  return (
    <div className="flex flex-col h-full min-w-0 bg-[#09090b]">
      {/* Top bar — fixed height prevents scrollbar jitter from resizing the terminal */}
      <div className="shrink-0 flex items-center px-2 pt-[max(10px,env(safe-area-inset-top))] pb-1.5 bg-zinc-900 border-b border-zinc-800 gap-1 overflow-hidden">
        {/* Back button — mobile only */}
        {!sidebarVisible && (
          <button
            onClick={detachSession}
            className="shrink-0 px-2.5 py-2 text-sm bg-zinc-800 text-zinc-400 rounded-lg
                       active:bg-zinc-700 transition-colors"
          >
            &larr;
          </button>
        )}

        {/* Mobile: tap the active session to open the quick switcher — jump
            between live agents without a trip back to the home screen. */}
        {!sidebarVisible && (
          <button
            onClick={() => setShowSwitcher(true)}
            className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1 active:bg-zinc-800 rounded-lg transition-colors"
          >
            {attachedSession?.profileIcon && (
              <span className="text-sm shrink-0">{attachedSession.profileIcon}</span>
            )}
            <span className="truncate text-xs text-zinc-300">
              {attachedSession?.name || attachedSession?.profileName || ''}
            </span>
            {/* Badge: how many OTHER live sessions want attention. */}
            {(() => {
              const others = sessions.filter((s) => s.id !== attachedSession?.id);
              const flagged = others.filter((s) => s.attention === 'waiting' || s.attention === 'error' || s.unseen).length;
              if (others.length === 0) return null;
              return (
                <span className={`shrink-0 text-[10px] px-1 rounded-full ${flagged ? 'bg-amber-500/20 text-amber-300' : 'text-zinc-600'}`}>
                  {flagged ? `${flagged}●` : `+${others.length}`}
                </span>
              );
            })()}
            <svg className="w-3 h-3 shrink-0 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        )}

        {/* Desktop: show active session name + spacer */}
        {sidebarVisible && (
          <div className="flex-1 px-2 text-xs text-zinc-500 truncate">
            {attachedSession?.profileName || attachedSession?.name || ''}
          </div>
        )}

        {/* Upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,.pdf,.txt,.log,.json,.csv,.zip,.tar,.gz"
          onChange={handleFileUpload}
          className="hidden"
        />
        <button
          onPointerDown={(e) => { e.preventDefault(); openSelectText(); }}
          className="shrink-0 px-2 py-2 text-zinc-500 active:text-zinc-300 transition-colors"
          title="Open terminal output for native text selection"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h10M4 14h16M4 18h10" />
          </svg>
        </button>
        <button
          onPointerDown={(e) => { e.preventDefault(); toggleKeyBar(); }}
          className={`shrink-0 px-2 py-2 transition-colors ${
            showKeyBar ? 'text-zinc-200' : 'text-zinc-500 active:text-zinc-300'
          }`}
          title="Toggle terminal keys (Esc, arrows, Tab, Ctrl)"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path strokeLinecap="round" d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" />
          </svg>
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="shrink-0 px-2 py-2 text-zinc-500 active:text-zinc-300 transition-colors"
          title="Upload file"
        >
          {uploading ? (
            <span className="w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin inline-block" />
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          )}
        </button>
      </div>

      {/* Window tabs — only show when session has multiple windows */}
      {windows.length > 1 && (
        <div className="shrink-0 flex items-center px-2 py-1 bg-zinc-900/50 border-b border-zinc-800/50 gap-1">
          {windows.map((w) => (
            <WindowTab key={w.index} w={w} windowCount={windows.length} />
          ))}
          <button
            onClick={() => createWindow()}
            className="shrink-0 px-2.5 py-1.5 text-xs text-zinc-600 active:text-zinc-400 transition-colors"
          >
            +
          </button>
        </div>
      )}

      {/* Terminal — absolute positioning gives xterm.js real pixel dimensions */}
      <div className="flex-1 min-h-0 relative" onClick={() => terminalRef.current?.focus()}>
        <div ref={termRef} className="absolute inset-0 overflow-hidden" />
        {/* Jump to live — escapes tmux copy-mode/scrollback back to the prompt.
            Discoverable counterpart to typing (which auto-exits server-side). */}
        {scrolledUp && (
          <button
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              exitScroll();
              terminalRef.current?.scrollToBottom();
              setScrolledUp(false);
              terminalRef.current?.focus();
            }}
            className="absolute left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3.5 h-9 rounded-full bg-zinc-700/95 text-zinc-100 text-xs font-medium shadow-lg active:bg-zinc-600"
            style={{ bottom: 'max(12px, env(safe-area-inset-bottom))' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
            Jump to live
          </button>
        )}
        {voice.isSupported && (
          <button
            // Belt-and-suspenders against the focus-steal that killed Ctrl+C
            // on desktop: mousedown.preventDefault blocks the focus shift
            // when the browser fires it; pointerdown.preventDefault covers
            // touch. We don't toggle from pointerdown anymore — that fired
            // twice on hybrid touch+mouse devices.
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}
            onClick={voice.toggle}
            className={`absolute right-3 bottom-3 z-10 w-11 h-11 rounded-full shadow-lg flex items-center justify-center transition-colors ${
              voice.isListening
                ? 'bg-red-500 text-white animate-pulse'
                : 'bg-zinc-800/90 text-zinc-300 active:bg-zinc-700'
            }`}
            style={{ bottom: 'max(12px, env(safe-area-inset-bottom))' }}
            title={voice.isListening ? 'Stop dictation' : 'Start dictation'}
            aria-label={voice.isListening ? 'Stop dictation' : 'Start dictation'}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
            </svg>
          </button>
        )}
      </div>

      {/* Soft-keyboard helper bar — mobile only, toggled from top bar */}
      {!sidebarVisible && showKeyBar && <TerminalKeyBar sendInput={sendInput} />}

      {/* Session quick-switcher — mobile only */}
      {!sidebarVisible && showSwitcher && (
        <SessionSwitcher
          sessions={sessions}
          currentId={attachedSession?.id ?? null}
          onPick={(id) => attachSession(id)}
          onNew={() => { setShowSwitcher(false); setShowTabPicker(true); }}
          onClose={() => setShowSwitcher(false)}
        />
      )}

      {/* Profile picker popup — mobile only */}
      {!sidebarVisible && showTabPicker && <TabPicker onClose={() => setShowTabPicker(false)} />}

      {/* Native text-selection modal — mobile-friendly copy. xterm renders to
          canvas so Android's long-press magnifier has nothing to grab.
          Dumping the buffer into a real <textarea> gives back native selection
          handles, magnifier, and the standard copy menu. */}
      {selectText !== null && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col">
          <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-zinc-900 border-b border-zinc-800 pt-[max(12px,env(safe-area-inset-top))]">
            <span className="text-sm font-semibold text-zinc-200">Select &amp; copy</span>
            <button
              onClick={() => setSelectText(null)}
              className="px-3 py-1.5 text-sm text-zinc-300 bg-zinc-800 active:bg-zinc-700 rounded-lg"
            >
              Close
            </button>
          </div>
          <textarea
            value={selectText}
            readOnly
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="flex-1 w-full p-4 bg-zinc-950 text-zinc-100 text-[13px] font-mono resize-none outline-none"
            style={{ whiteSpace: 'pre' }}
          />
        </div>
      )}
    </div>
  );
}
