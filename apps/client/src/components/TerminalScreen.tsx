import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useAppStore } from '../stores/appStore';
import type { Profile } from '@persalink/shared/protocol';

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
  const { profiles, sessions, createSession, attachSession } = useAppStore();

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
    const liveSession = sessions.find(s => s.profileId === profile.id);
    if (liveSession) {
      attachSession(liveSession.id);
    } else {
      createSession(profile.id);
    }
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

export function TerminalScreen({ sidebarVisible = false }: { sidebarVisible?: boolean }) {
  const {
    attachedSession, sendInput, resize, detachSession, killSession,
    initialScrollback, windows, selectWindow, createWindow, serverUrl, authToken,
    sessions, activeTabId, switchTab, closeTab, showTabPicker, setShowTabPicker, getTabs,
  } = useAppStore();

  const tabs = useMemo(() => getTabs(), [sessions]);

  const [uploading, setUploading] = useState(false);
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

      const url = serverUrl.startsWith('http')
        ? serverUrl
        : `http://${serverUrl}`;

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

    // Auto-copy on select (like a real terminal)
    const clipboardWrite = (text: string) => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        });
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
    };

    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) clipboardWrite(sel);
    });

    // Paste via browser paste event (works on HTTP)
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        sendInput(text);
      }
    };
    termRef.current!.addEventListener('paste', onPaste as EventListener);

    // Ctrl+V triggers native paste
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      if (e.ctrlKey && e.key === 'v') {
        document.execCommand('paste');
        return false;
      }

      return true;
    });

    // IME composition fix for Android keyboards (GBoard, SwiftKey).
    //
    // Problem: xterm's hidden textarea accumulates value across compositions.
    // After each compositionend, xterm reads textarea.value and fires onData
    // with the FULL accumulated text, not just the new character. This causes
    // every keystroke to re-send everything previously typed.
    //
    // Fix: track what we've already sent from composition results and compute
    // the delta. Works regardless of whether textarea.value gets cleared
    // between keystrokes or not.
    let composing = false;
    let justComposed = false;
    let compositionSent = '';   // accumulated text we've already forwarded
    let compositionResetTimer: ReturnType<typeof setTimeout> | null = null;
    const textarea = termRef.current!.querySelector('textarea');
    if (textarea) {
      textarea.addEventListener('compositionstart', () => { composing = true; });
      textarea.addEventListener('compositionend', () => {
        composing = false;
        justComposed = true;
      });
    }

    term.onData((data) => {
      if (composing) return;

      if (justComposed) {
        justComposed = false;

        if (compositionSent && data.startsWith(compositionSent)) {
          // Textarea accumulated — data is prev + new chars. Send only delta.
          const delta = data.slice(compositionSent.length);
          compositionSent = data;
          if (delta) sendInput(delta);
        } else if (compositionSent && compositionSent.startsWith(data)) {
          // Shrunk (backspace during composition) — send DEL for removed chars
          const removed = compositionSent.length - data.length;
          compositionSent = data;
          for (let i = 0; i < removed; i++) sendInput('\x7f');
        } else {
          // First composition keystroke, or textarea was cleared between
          // keystrokes (no accumulation). Send as-is.
          compositionSent = data;
          sendInput(data);
        }

        // Reset tracking after a typing pause so stale state doesn't
        // interfere with the next burst of typing
        if (compositionResetTimer) clearTimeout(compositionResetTimer);
        compositionResetTimer = setTimeout(() => { compositionSent = ''; }, 1500);
        return;
      }

      // Non-composition input (desktop keys, paste, arrow keys, etc.)
      compositionSent = '';
      sendInput(data);
    });

    fitAddonRef.current = fitAddon;

    // Touch scroll for mobile — translate swipes into xterm scroll
    let touchStartY = 0;
    let scrollAccum = 0;
    const LINE_PX = 18;
    const container = termRef.current;

    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
      scrollAccum = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const dy = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;
      scrollAccum += dy;
      const lines = Math.trunc(scrollAccum / LINE_PX);
      if (lines !== 0) {
        scrollAccum -= lines * LINE_PX;
        term.scrollLines(lines);
      }
    };
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });

    // Handle resize — debounced, and only refit if the grid size actually changes.
    // xterm snaps to whole character cells, so a 1-2px jitter (e.g. tab bar
    // overflow recalculating) would drop a row then re-add it, causing flicker.
    let lastCols = term.cols;
    let lastRows = term.rows;
    const doFit = () => {
      fitAddon.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        resize(term.cols, term.rows);
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(doFit, 100);
    });
    resizeObserver.observe(termRef.current);

    // Re-fit after layout settles — triple pass: immediate rAF, delayed rAF,
    // and a timer to catch slow CSS transitions or conditional bar changes.
    requestAnimationFrame(() => requestAnimationFrame(doFit));
    setTimeout(doFit, 200);

    // Auto-focus terminal after mount + any pending click events resolve.
    requestAnimationFrame(() => term.focus());
    setTimeout(() => term.focus(), 150);

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('paste', onPaste as EventListener);
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      terminalRef.current = null;
      term.dispose();
    };
  }, [attachedSession?.id]);

  return (
    <div className="flex flex-col h-full min-w-0 bg-[#09090b]">
      {/* Top bar — fixed height prevents scrollbar jitter from resizing the terminal */}
      <div className="shrink-0 flex items-center px-2 pt-[max(6px,var(--sat))] pb-1.5 bg-zinc-900 border-b border-zinc-800 gap-1 overflow-hidden">
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

        {/* Session tabs — mobile only (desktop uses sidebar) */}
        {!sidebarVisible && (
          <div className="flex gap-0.5 flex-1 overflow-x-auto scrollbar-none" style={{ scrollbarWidth: 'none' }}>
            {tabs.map((tab) => (
              <div
                key={tab.sessionId}
                className={`shrink-0 flex items-center gap-0.5 rounded-lg transition-colors ${
                  tab.sessionId === activeTabId
                    ? 'bg-zinc-700'
                    : ''
                }`}
              >
                <button
                  onClick={() => switchTab(tab.sessionId)}
                  className={`flex items-center gap-1.5 pl-2.5 pr-1 py-2 text-xs transition-colors ${
                    tab.sessionId === activeTabId
                      ? 'text-zinc-100'
                      : 'text-zinc-500 active:text-zinc-300'
                  }`}
                >
                  {tab.icon && <span className="text-xs">{tab.icon}</span>}
                  {tab.color && (
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: tab.color }} />
                  )}
                  <span className="truncate max-w-[70px]">{tab.name}</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); killSession(tab.sessionId); }}
                  className="px-1 py-1 text-zinc-600 active:text-red-400 transition-colors text-xs mr-0.5"
                  title="Kill session"
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              onClick={() => setShowTabPicker(true)}
              className="shrink-0 px-2.5 py-2 text-sm text-zinc-600 active:text-zinc-400 transition-colors"
              title="Open new session"
            >
              +
            </button>
          </div>
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
      </div>

      {/* Profile picker popup — mobile only */}
      {!sidebarVisible && showTabPicker && <TabPicker onClose={() => setShowTabPicker(false)} />}
    </div>
  );
}
