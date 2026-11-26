import { useEffect, useRef, useCallback, useState, useMemo, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { useAppStore } from '../stores/appStore';
import { handleOsc52 } from '../lib/clipboardBridge';
import { openExternal, promptOpen } from '../lib/linkOpen';
import { ClaudeSheet, type ClaudeTab } from './ClaudeReplyPanel';
import { Composer, wrapForPaste, type ComposerContext } from './Composer';
import { ReaderMirror } from '../lib/readerMirror';
import { isNativeShell } from '../lib/platform';
import { hasPendingShare, SHARE_PENDING_OP } from '../lib/shareTarget';
import { useTerminalStyleStore, getTheme, getFontStack } from '../stores/terminalStyleStore';
import { TerminalSettings } from './TerminalSettings';
import { SessionIcon } from './ui/ProfileTile';
import { SnippetSheet } from './SnippetSheet';
import { useVoiceInput, voiceSupported } from '../lib/voiceInput';
import { saveDims } from '../lib/terminalDims';
import { createSwipeAutoSpacer } from '../lib/swipeAutoSpace';
import { uploadFiles } from '../lib/upload';
import { orderSessions, waitingSessions } from '../lib/sessionOrder';
import { ExitedTombstone } from './ExitedTombstone';
import { KeyRow } from './ui/KeyRow';
import { CommandLine, type CommandLineHandle } from './ui/CommandLine';
import { Sheet } from './ui/Sheet';
import { IconButton } from './ui/IconButton';
import { PhoneHeader, HeaderFlash } from './ui/PhoneHeader';
import { ConnectionReadout } from './ui/ConnectionReadout';
import { Dock, type DockItem } from './ui/Dock';
import { AnswerBar } from './ui/AnswerBar';
import { useAnswerSend } from './ui/AnswerChips';
import { readout } from '../lib/readout';
import { ReconnectBanner } from './ui/Reconnect';
import { sessionTitle, stateKey, stateWord } from '../lib/sessionState';
import {
  ArrowDown, Braces, Check, ChevronDown, ChevronUp, ClipboardCopy, ClipboardPaste, Copy, Ellipsis, Keyboard, Link,
  MessageSquare, Mic, Palette, Paperclip, Plus, Rows3, Search, SquarePlus, TextCursor, TextSearch, X,
} from 'lucide-react';
import { PANE_COMMAND_EVENT, PHONE_TERMINAL, type PaneCommandDetail } from '../lib/paneCommands';
import { answerOptions, isRedirectOption, isTick, NEXT_KEY, promptOnScreen, samePromptState, type ClaudePrompt, type PromptOption } from '../lib/claudePrompt';
import { useGlobalShortcuts } from './ShortcutsPanel';
import { MoreSheet, type MenuItem } from './ui/MoreSheet';
import { SessionSwitcher, NewSessionSheet } from './ui/SessionSwitcher';
import { useUiStore } from '../stores/uiStore';

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
      className={`shrink-0 flex items-center gap-0.5 rounded-[6px] transition-colors duration-(--d-press) ${
        w.active ? 'bg-bg-3' : ''
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
          aria-label="Window name"
          className="w-24 h-8 px-2 bg-bg-term border border-line-2 rounded-[6px] text-meta text-fg-1 outline-none focus:border-accent/45"
          autoFocus
        />
      ) : (
        <button
          onClick={() => selectWindow(w.index)}
          onDoubleClick={startEditing}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={`h-9 px-3 text-body transition-colors duration-(--d-press) ${
            w.active ? 'text-fg-1 font-medium' : 'text-fg-3 active:text-fg-1'
          }`}
        >
          {w.name}
        </button>
      )}
      {windowCount > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); killWindow(w.index); }}
          className="w-7 h-9 grid place-items-center text-fg-3 active:text-danger transition-colors duration-(--d-press)"
          title={`Close window ${w.name}`}
          aria-label={`Close window ${w.name}`}
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

// Harvested-links sheet. tmux hard-wraps long URLs at the pane width, so the
// in-terminal WebLinksAddon only ever sees the split halves — unclickable, and
// selecting them copies a mid-URL line break. The server rejoins wrapped lines
// (capture-pane -J) and extracts whole URLs; this sheet lists them newest
// first as big tappable targets with a per-row copy.
function LinkSheet({ links, onClose }: { links: string[]; onClose: () => void }) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const copy = async (url: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1200);
    } catch { /* clipboard denied — opening via the anchor still works */ }
  };
  return (
    <Sheet title="Links in this session" sub="Newest first, whole even when wrapped" onClose={onClose}>
      {links.length === 0 && (
        <div className="px-3 py-8 text-center text-body text-fg-3">No links in recent output</div>
      )}
      {links.map((url, i) => (
        <div key={`${url}-${i}`} className="flex items-center gap-1">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 min-w-0 px-3 py-3 text-body text-accent-hi active:bg-bg-3 rounded-[10px] break-all"
          >
            {url}
          </a>
          <IconButton label={copiedIdx === i ? 'Copied' : 'Copy link'} onClick={() => copy(url, i)}>
            {copiedIdx === i
              ? <Check className="w-4 h-4 text-accent-hi" strokeWidth={1.75} />
              : <Copy className="w-4 h-4" strokeWidth={1.75} />}
          </IconButton>
        </div>
      ))}
    </Sheet>
  );
}

// Enter and Backspace are the two keys a soft keyboard reports with a real `code`, so
// they cannot count as evidence of a physical one — treating them as such would put a
// keyboard-less phone back into inputmode="text" and summon Gboard on every terminal tap,
// which is the whole thing inputmode="none" exists to prevent.
const SOFT_KEYBOARD_CODES = new Set(['Enter', 'NumpadEnter', 'Backspace']);

/**
 * Whether a keydown came from a real key rather than a soft keyboard's composition.
 *
 * A soft IME composites text and reports keydowns with keyCode 229, an empty `code`, or
 * key "Unidentified". Anything else carrying a genuine `code` came from hardware.
 */
/**
 * Phones whose defining feature is a physical keyboard. Matched against the device model so a
 * fresh install knows before a key is ever pressed — detection alone cannot cover that case,
 * because the keypress that would prove the keyboard exists has already bypassed the IME by
 * the time we see it.
 */
const HARDWARE_KEYBOARD_MODELS =
  /\b(?:Titan|BB[BEF]100|Pro1|Astro[ _]?Slide|Cosmo[ _]?Communicator)\b/i;

/**
 * Synchronous best effort. Chrome's reduced Android user-agent freezes the model to "K", so
 * this only fires where the full string survives (WebViews, older Chrome). The client-hint
 * path below covers everywhere else.
 */
function userAgentSuggestsHardwareKeyboard(): boolean {
  if (typeof navigator === 'undefined') return false;
  try { return HARDWARE_KEYBOARD_MODELS.test(navigator.userAgent); } catch { return false; }
}

/**
 * The real device model, via high-entropy client hints — the one place Chrome still exposes
 * it on Android. Async, so it lands a tick after mount, which is still long before a keypress.
 */
async function modelSuggestsHardwareKeyboard(): Promise<boolean> {
  try {
    const uaData = (navigator as Navigator & {
      userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ model?: string }> };
    }).userAgentData;
    if (!uaData?.getHighEntropyValues) return false;
    const { model } = await uaData.getHighEntropyValues(['model']);
    return !!model && HARDWARE_KEYBOARD_MODELS.test(model);
  } catch { return false; }
}

function isPhysicalKeyEvent(e: KeyboardEvent): boolean {
  return e.isTrusted
    && e.keyCode !== 229
    && !!e.code
    && e.key !== 'Unidentified'
    && !SOFT_KEYBOARD_CODES.has(e.code);
}

export function TerminalScreen() {
  const {
    attachedSession, sendInput, exitScroll, resize, detachSession,
    windows, createWindow, serverUrl, authToken,
    sessions, showTabPicker, setShowTabPicker,
    connectionState, requestLinks, sessionLinks, clearSessionLinks,
    claudeReply, requestClaudeReply, clearClaudeReply,
  } = useAppStore();
  const filesDisabled = useAppStore((s) => s.filesDisabled);
  const endedSession = useAppStore((s) => s.endedSession);
  const restartEnded = useAppStore((s) => s.restartEnded);
  const dismissEnded = useAppStore((s) => s.dismissEnded);
  const openPalette = useUiStore((s) => s.openPalette);
  const openShortcuts = useUiStore((s) => s.openShortcuts);
  const ended = endedSession && endedSession.id === attachedSession?.id ? endedSession : null;
  // attachedSession is the snapshot taken at attach; state lives in the list.
  const liveAttached = sessions.find((s) => s.id === attachedSession?.id) ?? attachedSession;
  const isEnded = !!ended;
  // The composer sheet: write or dictate, review, then send once. `listen`
  // opens it with the mic on (Dictate); `redirectKey` is the "No, and tell
  // Claude..." option, pressed only when the message is actually sent.
  const [composer, setComposer] = useState<null | {
    listen: boolean;
    redirectKey?: string;
    context: ComposerContext | null;
  }>(null);

  // 'authenticated' is the only fully-usable state; anything else means input
  // won't reach the session, so surface it instead of dropping keystrokes silently.
  const online = connectionState === 'authenticated';

  const [uploading, setUploading] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  // Terminal appearance bottom sheet (themes/font/size) — mobile finally gets
  // the same styling controls the desktop grid's gear popover has.
  const [showStyleSheet, setShowStyleSheet] = useState(false);
  // Snippet library sheet (opened from the key bar's {} key).
  const [showSnippets, setShowSnippets] = useState(false);
  // Hardware-keyboard detection (Titan etc.): soft IMEs composite text and don't emit
  // keydowns with real codes, so the first trusted one that does means a physical keyboard
  // exists. Deliberately NOT limited to letters and digits: reaching a symbol on the Titan
  // starts with Alt or Sym, and until detection flips, inputmode stays "none" and the IME is
  // out of the pipeline — so the very chord that most needs the IME was the one that could
  // never switch it on, and its symbol was swallowed. Modifiers count as evidence now.
  // Sticky per device — once seen, the soft-keyboard dial item is dead weight and hides.
  const [detectedHw, setDetectedHw] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (userAgentSuggestsHardwareKeyboard()) return true;
    try { return localStorage.getItem('persalink-hw-keyboard') === 'true'; } catch { return false; }
  });
  // Client hints resolve a tick after mount. Deliberately NOT written to localStorage: a model
  // match should stay a live answer, so a wrong pattern here can never be baked into a device
  // permanently the way a real keypress legitimately is.
  useEffect(() => {
    if (detectedHw) return;
    let cancelled = false;
    void modelSuggestsHardwareKeyboard().then((isHardware) => {
      if (!cancelled && isHardware) setDetectedHw(true);
    });
    return () => { cancelled = true; };
  }, [detectedHw]);
  useEffect(() => {
    if (detectedHw) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isPhysicalKeyEvent(e)) return;
      // Gboard's cursor arrows send real key codes into the command line;
      // they must not turn a touch phone into a "keyboard phone" for good.
      if (e.target instanceof Element && e.target.closest('.pl-cmdline')) return;
      setDetectedHw(true);
      try { localStorage.setItem('persalink-hw-keyboard', 'true'); } catch { /* private mode */ }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [detectedHw]);
  // Settings → Terminal → "This phone" can overrule detection either way
  // (a Bluetooth keyboard once paired with a Pixel, a keyboard phone the
  // model list misses).
  const phoneKeyboard = useTerminalStyleStore((s) => s.phoneKeyboard);
  const hwKeyboard = phoneKeyboard === 'auto' ? detectedHw : phoneKeyboard === 'keys';
  // Touch-screen phones type into the command line (a real text box with
  // Send) instead of straight into the terminal. Its keyboard icon switches
  // to live typing until the keyboard goes away.
  const [liveTyping, setLiveTyping] = useState(false);
  const lineShown = !hwKeyboard && !liveTyping;
  const lineShownRef = useRef(lineShown);
  lineShownRef.current = lineShown;
  const cmdRef = useRef<CommandLineHandle>(null);
  // When a tap on the cursor row last handed the keyboard to the command
  // line: the click that follows the same tap must not take it back.
  const cmdTapAtRef = useRef(0);
  // Input-debug overlay (Settings → "Input debug overlay"): shows the raw
  // events reaching the app so exotic hardware (Titan keyboard-swipe scroll,
  // odd Sym layers) can be diagnosed from the device itself. Consecutive
  // identical events coalesce ("touch move ×14") so bursts stay readable.
  const inputDebug = useTerminalStyleStore((s) => s.inputDebug);
  const [debugLog, setDebugLog] = useState<Array<{ msg: string; n: number }>>([]);
  // Component-scope so the gesture engine can also report what it DID with
  // the events ("scroll -3", "joystick on") — the window listeners only prove
  // events reached the page, not that the terminal's engine consumed them.
  const pushDebug = useCallback((msg: string) => {
    if (!useTerminalStyleStore.getState().inputDebug) return;
    setDebugLog((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.msg === msg) return [...prev.slice(0, -1), { msg, n: last.n + 1 }];
      return [...prev.slice(-9), { msg, n: 1 }];
    });
  }, []);
  useEffect(() => {
    if (!inputDebug) { setDebugLog([]); return; }
    const push = pushDebug;
    // Short "where did this land" tag: tag name + first class token.
    const elTag = (t: EventTarget | null) => {
      if (!(t instanceof Element)) return 'doc';
      const cls = t.className?.toString().split(' ')[0];
      return `${t.tagName.toLowerCase()}${cls ? '.' + cls.slice(0, 18) : ''}`;
    };
    const onKey = (e: KeyboardEvent) =>
      push(`key ${e.key === ' ' ? 'Space' : e.key}${e.ctrlKey ? ' +ctrl' : ''}${e.altKey ? ' +alt' : ''} (${e.code})`);
    const onWheel = (e: WheelEvent) =>
      push(`wheel ${e.deltaY >= 0 ? 'down' : 'up'} ${Math.abs(Math.round(e.deltaY))}`);
    const onTs = (e: TouchEvent) => {
      const t = e.touches[0];
      push(`touch start (${Math.round(t?.clientX ?? -1)},${Math.round(t?.clientY ?? -1)}) @${elTag(e.target)}`);
    };
    const onTm = () => push('touch move');
    const onTe = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      push(`touch end (${Math.round(t?.clientX ?? -1)},${Math.round(t?.clientY ?? -1)})`);
    };
    const onPd = (e: PointerEvent) => push(`pointer ${e.pointerType || '?'} @${elTag(e.target)}`);
    const onScroll = (e: Event) => {
      const t = e.target as Element | Document;
      const name = t instanceof Element ? (t.className?.toString().split(' ')[0] || t.tagName) : 'doc';
      push(`scroll-evt ${name}`);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onWheel, true);
    window.addEventListener('touchstart', onTs, true);
    window.addEventListener('touchmove', onTm, true);
    window.addEventListener('touchend', onTe, true);
    window.addEventListener('pointerdown', onPd, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('touchstart', onTs, true);
      window.removeEventListener('touchmove', onTm, true);
      window.removeEventListener('touchend', onTe, true);
      window.removeEventListener('pointerdown', onPd, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [inputDebug, pushDebug]);
  // Suggestion bar: prefix-matched shell history for the current typed
  // command (normal buffer only — alt-screen apps get no noise).
  const [sugg, setSugg] = useState<{ prefix: string; items: string[] }>({ prefix: '', items: [] });
  // Find-in-scrollback (xterm search addon). The addon instance lives in the
  // terminal effect; the bar UI drives it through this ref.
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCount, setSearchCount] = useState<{ current: number; total: number } | null>(null);
  const SEARCH_DECOR = {
    decorations: {
      matchBackground: '#713f12',
      matchBorder: '#713f12',
      matchOverviewRuler: '#eab308',
      activeMatchBackground: '#f59e0b',
      activeMatchBorder: '#f59e0b',
      activeMatchColorOverviewRuler: '#f59e0b',
    },
  };
  const runSearch = useCallback((q: string, incremental: boolean) => {
    setSearchQuery(q);
    if (!q) {
      searchAddonRef.current?.clearDecorations();
      setSearchCount(null);
      return;
    }
    searchAddonRef.current?.findNext(q, { ...SEARCH_DECOR, incremental });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const closeSearch = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
    setShowSearch(false);
    setSearchQuery('');
    setSearchCount(null);
    terminalRef.current?.focus();
  }, []);
  // Soft-keyboard policy: the terminal surface is NOT a keyboard trigger.
  // xterm's hidden textarea runs with inputmode="none" (focus works — key
  // bar, hardware keys, selection — but no soft keyboard), and the floating
  // keyboard button below flips it to text + refocuses. Tapping anywhere in
  // the session no longer summons Gboard.
  //
  // EXCEPT on hardware-keyboard devices (hwImeCompat, default on):
  // inputmode="none" also cuts the IME out of the key pipeline, so keyboard
  // apps like Physiboard lose their Alt symbol layer (Alt+M → ".") and their
  // auto-caps logic runs blind and inverts. A detected physical keyboard
  // keeps a real "text" connection — its IME is a thin helper, not a
  // screen-covering Gboard, so the original problem doesn't apply.
  const softKbOnRef = useRef(false);
  const hwKeyboardRef = useRef(hwKeyboard);
  hwKeyboardRef.current = hwKeyboard;
  const resolveInputMode = useCallback((on: boolean): 'text' | 'none' => {
    if (on) return 'text';
    return hwKeyboardRef.current && useTerminalStyleStore.getState().hwImeCompat ? 'text' : 'none';
  }, []);
  const applySoftKb = useCallback((on: boolean) => {
    softKbOnRef.current = on;
    const term = terminalRef.current;
    const ta = term?.textarea;
    if (!ta) return;
    ta.inputMode = resolveInputMode(on);
    // Android only re-reads inputmode on a fresh focus — cycle it.
    ta.blur();
    if (on) term?.focus();
    else term?.focus(); // refocus keeps hardware keys + cursor; no soft kb with inputmode none
  }, [resolveInputMode]);
  // Re-apply when hw-keyboard detection or the compat setting flips (Android
  // only re-reads inputmode on a fresh focus, hence the blur/focus cycle).
  const hwImeCompat = useTerminalStyleStore((s) => s.hwImeCompat);
  useEffect(() => {
    const term = terminalRef.current;
    const ta = term?.textarea;
    if (!ta) return;
    const mode = resolveInputMode(softKbOnRef.current);
    if (ta.inputMode === mode) return;
    ta.inputMode = mode;
    // Only cycle a terminal that had focus: the first key typed into the
    // palette or the composer flips detection and must stay there.
    if (document.activeElement !== ta) return;
    ta.blur();
    term?.focus();
  }, [hwKeyboard, hwImeCompat, resolveInputMode]);

  // Sticky Ctrl (key bar): state drives the button highlight, the ref is what
  // the xterm onData closure reads — it mounts once and never re-binds.
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrlArmedRef = useRef(false);
  const toggleCtrl = useCallback(() => {
    const next = !ctrlArmedRef.current;
    ctrlArmedRef.current = next;
    setCtrlArmed(next);
  }, []);
  // True when the user has scrolled the pane up (possibly into tmux copy-mode);
  // surfaces the "jump to live" button. Typing auto-exits copy-mode server-side.
  const [scrolledUp, setScrolledUp] = useState(false);
  // Alt-screen apps own their buffer, so there's no scroll position to read.
  // Track net up-scrolled lines as a proxy so the jump button can clear when
  // the user scrolls back down to live themselves (it used to stick until a
  // keystroke). Reset by typing, jumping, or paying the count back to zero.
  const altUpLinesRef = useRef(0);
  // Momentum-fling cancel, reachable from jumpToLive — tapping the button
  // mid-fling must stop the fling, or its queued wheel-ups scroll away from
  // live again and instantly re-surface the button.
  const cancelMomentumRef = useRef<(() => void) | null>(null);
  // Trailing scroll events (OS wheel inertia, in-flight touch momentum) right
  // after a jump would re-arm the button — ignore re-arms briefly.
  const suppressRearmUntilRef = useRef(0);
  // Android share sheet landed text in this app → offer it to the session the
  // user just attached. Tap-to-insert (never auto-typed — shared text can
  // contain newlines, which a shell would execute).
  useEffect(() => {
    if (!attachedSession?.id || !hasPendingShare()) return;
    useAppStore.getState().pushNotification(
      'info',
      'Shared text ready — tap here to type it into this session',
      SHARE_PENDING_OP,
    );
  }, [attachedSession?.id]);

  // OS-native text selection over the canvas (lib/readerMirror.ts). Built
  // inside the terminal effect; the toolbar and the click guard reach it here.
  const readerRef = useRef<ReaderMirror | null>(null);
  // Fallback paste surface for origins where the clipboard API is locked
  // (plain-http LAN servers): an editable box the OS *will* offer Paste on.
  const [pasteCatcher, setPasteCatcher] = useState(false);
  const pasteCatcherRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pasteCatcher) pasteCatcherRef.current?.focus();
  }, [pasteCatcher]);

  // Toolbar paste — the only paste path a phone user can reach (no Ctrl+V,
  // and xterm's canvas offers no long-press paste menu).
  const pasteFromClipboard = useCallback(async () => {
    try {
      if (isNativeShell()) {
        // The Capacitor WebView rejects navigator.clipboard.readText (it has
        // no permission UI); the plugin reads the system clipboard directly.
        const { Clipboard } = await import('@capacitor/clipboard');
        const { value, type } = await Clipboard.read();
        if (value && (!type || type.startsWith('text'))) sendInput(value);
        terminalRef.current?.focus();
        return;
      }
      if (!navigator.clipboard?.readText || !window.isSecureContext) throw new Error('clipboard unavailable');
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
    } catch {
      // Touch devices get a surface the OS will paste into; a desktop
      // browser has Ctrl+V and just needs to know why the button failed.
      if (window.matchMedia('(pointer: coarse)').matches) {
        setPasteCatcher(true);
        return;
      }
      useAppStore.getState().pushNotification(
        'error',
        'Paste blocked — clipboard needs HTTPS and permission.',
        'paste',
      );
    }
    terminalRef.current?.focus();
  }, [sendInput]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOutputRef = useRef<Array<{ data: string; sessionId: string }>>([]);
  const sessionIdRef = useRef<string | null>(null);

  // Wheel-down burst for alt-screen apps that own their scrollback via mouse
  // mode (vim, less). Claude Code 2.x can NOT be driven this way anymore — its
  // redesigned input loop coalesces/drops large wheel bursts, so even
  // thousands of wheel-down events fail to reach the bottom of a long
  // conversation (measured: 13×250 events still short). It advertises
  // Ctrl+End as its jump-to-latest key instead; we send both.
  const SNAP_WHEEL_BURST = 250;
  const CLAUDE_JUMP_TO_LATEST = '\x1b[1;5F'; // Ctrl+End

  // "Jump to live" / return-to-bottom. Routes by buffer mode:
  //   alternate (Claude/vim/less) → Ctrl+End (Claude's own jump-to-latest
  //     key, instant on any conversation length) followed by a wheel-down
  //     burst for apps that don't bind Ctrl+End but do track the mouse.
  //   normal shell buffer → scroll xterm's own viewport down.
  // Both paths also cancel tmux copy-mode (a safe no-op otherwise) — an
  // alt-screen app WITHOUT mouse tracking leaves wheel-up scrolling tmux
  // itself, and only the cancel brings that back to live.
  const jumpToLive = useCallback(() => {
    const term = terminalRef.current;
    cancelMomentumRef.current?.();
    altUpLinesRef.current = 0;
    suppressRearmUntilRef.current = performance.now() + 600;
    exitScroll();
    if (term && term.buffer.active.type === 'alternate') {
      sendInput(CLAUDE_JUMP_TO_LATEST + '\x1b[<65;1;1M'.repeat(SNAP_WHEEL_BURST));
    } else {
      term?.scrollToBottom();
    }
    setScrolledUp(false);
    term?.focus();
  }, [sendInput, exitScroll]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    try {
      const paths = await uploadFiles(files, { serverUrl, authToken });
      // Paste all uploaded paths space-separated, with a trailing space so the
      // user can keep typing (e.g. a command in front of the file list).
      if (paths.length > 0) {
        if (lineShownRef.current && cmdRef.current) {
          // The command line owns typing: the paths join what is in the box.
          cmdRef.current.insert(paths.join(' ') + ' ');
        } else {
          sendInput(paths.join(' ') + ' ');
          // The file picker stole focus — hand it straight back with the
          // keyboard up, since the next act is always typing around the path.
          applySoftKb(true);
        }
      }
    } catch (err) {
      // Without this, a rejected upload (auth failure, size cap, network drop)
      // was an unhandled rejection: the spinner cleared and the user got no
      // feedback at all. Surface it.
      useAppStore.getState().pushNotification(
        'error',
        `Upload failed: ${err instanceof Error ? err.message : err}`,
        'upload',
      );
    } finally {
      setUploading(false);
      // Reset input so the same file(s) can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (!lineShownRef.current) terminalRef.current?.focus();
    }
  };

  // ------------------------------------------------------------------
  // Phone shell state: the header's second line, the answer bar, the key
  // row and the dock, and the slide between sessions.
  // ------------------------------------------------------------------
  const rttMs = useAppStore((s) => s.rttMs);
  const k = liveAttached ? stateKey(liveAttached) : null;
  const title = attachedSession ? sessionTitle(attachedSession) : '';

  // A short confirmation in the header's second line ("Sent to Olive").
  const [flash, setFlash] = useState<{ text: string; id: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((text: string) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash({ text, id: Date.now() });
    flashTimer.current = setTimeout(() => setFlash(null), 2000);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // The numbered question on screen, read shortly after output settles, and
  // only while this session's agent waits.
  const [prompt, setPrompt] = useState<ClaudePrompt | null>(null);
  const watchPromptRef = useRef(false);
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readPrompt = useCallback(() => {
    const t = terminalRef.current;
    const next = t && watchPromptRef.current ? promptOnScreen(t) : null;
    setPrompt((cur) => (cur && next && samePromptState(cur, next) ? cur : next));
  }, []);
  const schedulePromptRef = useRef<() => void>(() => {});
  schedulePromptRef.current = () => {
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    promptTimerRef.current = setTimeout(readPrompt, 180);
  };
  useEffect(() => () => { if (promptTimerRef.current) clearTimeout(promptTimerRef.current); }, []);
  const watching = k === 'waiting' && !isEnded;
  useEffect(() => {
    watchPromptRef.current = watching;
    if (watching) schedulePromptRef.current();
    else setPrompt(null);
  }, [watching, attachedSession?.id]);

  // One send rule: a chip sends at once; line 2 says "Answered: Yes · Stop" for 3s.
  const { answer: sendAnswer, confirmation } = useAnswerSend(sendInput);

  // Dictate types each finished phrase straight into the session, like a
  // keyboard; nothing is sent until Enter. The composer (More, the reply chip,
  // Alt+M) keeps its own mic for a message you want to edit first.
  const canDictate = useMemo(() => voiceSupported(), []);
  const voice = useVoiceInput(useCallback((text: string) => {
    sendInput(text);
  }, [sendInput]));
  useEffect(() => {
    if (!voice.error) return;
    useAppStore.getState().pushNotification('error', voice.error, 'voice');
  }, [voice.error]);
  // Switching sessions stops the mic, so words never land in the wrong one.
  const { stop: stopVoice } = voice;
  useEffect(() => { stopVoice(); }, [attachedSession?.id, stopVoice]);
  const recentLines = useCallback((n: number): string[] => {
    const t = terminalRef.current;
    if (!t) return [];
    const b = t.buffer.active;
    const out: string[] = [];
    for (let i = b.baseY + b.cursorY; i >= 0 && out.length < n; i--) {
      const text = b.getLine(i)?.translateToString(true) ?? '';
      const trimmed = text.trim();
      // Skip blank rows, box frames and a bare prompt: what is left is what the session last said.
      if (!trimmed || /^[╭╰│─]/.test(trimmed) || /^[>❯$%#]\s*$/.test(trimmed)) continue;
      out.unshift(text.replace(/\s+$/, ''));
    }
    return out;
  }, []);
  const openComposer = useCallback((opts: { listen: boolean; redirectKey?: string }) => {
    const s = useAppStore.getState().sessions.find((x) => x.id === attachedSession?.id) ?? attachedSession;
    const p = watchPromptRef.current ? prompt : null;
    let context: ComposerContext | null = null;
    if (s && p && stateKey(s) === 'waiting') {
      context = { kind: 'question', head: `${sessionTitle(s)} asks · ${stateWord(s)}`, question: p.question || 'Waiting for you' };
    } else {
      context = { kind: 'lines', label: `Last lines in ${s ? sessionTitle(s) : 'the session'}`, lines: recentLines(3) };
    }
    setComposer({ listen: opts.listen && canDictate, redirectKey: opts.redirectKey, context });
  }, [attachedSession, prompt, canDictate, recentLines]);
  // Reply in your own words. On a permission prompt that IS "No, and tell
  // Claude what to do differently": Send presses that option first.
  const openReply = useCallback(() => {
    const redirect = prompt?.options.find(isRedirectOption);
    openComposer({ listen: true, redirectKey: redirect?.key });
  }, [prompt, openComposer]);

  const answer = useCallback((o: PromptOption) => {
    const reread = (ms: number) => setTimeout(() => { if (watchPromptRef.current) readPrompt(); }, ms);
    if (o.key === NEXT_KEY) {
      // On to the form's next question (or its review screen).
      sendInput(NEXT_KEY);
      setPrompt(null);
      reread(600);
      return;
    }
    if (isRedirectOption(o)) { openReply(); return; }
    if (isTick(o)) {
      // A tick, not an answer: the form stays, the boxes update in place.
      sendInput(o.key);
      reread(250);
      return;
    }
    sendAnswer(o);
    setPrompt(null);
    // Look again once the agent has had time to move on: if the question is
    // still there (the key did not take), the bar comes back.
    setTimeout(() => { if (watchPromptRef.current) readPrompt(); }, 1500);
  }, [openReply, sendAnswer, readPrompt, sendInput]);

  const deliverText = useCallback((text: string, enter: boolean, redirectKey?: string) => {
    const go = () => {
      const bracketed = terminalRef.current?.modes.bracketedPasteMode ?? false;
      sendInput(wrapForPaste(text, bracketed));
      if (enter) setTimeout(() => sendInput('\r'), 60);
    };
    if (redirectKey) {
      // Pick "No, and tell Claude..." and give its text field a moment to open.
      sendInput(redirectKey);
      setPrompt(null);
      setTimeout(go, 300);
    } else {
      go();
    }
    say(enter ? `Sent to ${title}` : 'Inserted · press Enter to send');
  }, [sendInput, say, title]);

  // Claude: answer the question in full, or copy the last reply.
  const [claudeTab, setClaudeTab] = useState<ClaudeTab | null>(null);
  useEffect(() => {
    // Copy from Claude asked for elsewhere (Alt+Y): show it.
    if (claudeReply !== null && claudeTab === null) setClaudeTab('copy');
  }, [claudeReply, claudeTab]);
  const closeClaude = useCallback(() => { setClaudeTab(null); clearClaudeReply(); }, [clearClaudeReply]);

  // Keys: the key row, and on a touch phone the soft keyboard with it. The
  // keyboard's real presence comes from the visual viewport, so the dock
  // folds away only while a soft keyboard actually covers the screen.
  const [keysOn, setKeysOn] = useState(() => {
    try { return localStorage.getItem('persalink-show-keybar') === 'true'; } catch { return false; }
  });
  const persistKeys = useCallback((on: boolean) => {
    setKeysOn(on);
    try { localStorage.setItem('persalink-show-keybar', String(on)); } catch { /* private mode */ }
  }, []);
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let base = vv.height;
    let width = window.innerWidth;
    let shown = false;
    const check = () => {
      if (window.innerWidth !== width) { width = window.innerWidth; base = vv.height; }
      base = Math.max(base, vv.height);
      const now = base - vv.height > 120;
      if (now === shown) return;
      shown = now;
      setKbVisible(now);
      // Put away by the system (Back): the key row goes with it, and live
      // typing hands back to the command line.
      if (!now) {
        setLiveTyping(false);
        if (softKbOnRef.current) {
          applySoftKb(false);
          persistKeys(false);
        } else if (lineShownRef.current) {
          persistKeys(false);
        }
      }
    };
    vv.addEventListener('resize', check);
    return () => vv.removeEventListener('resize', check);
  }, [applySoftKb, persistKeys]);
  const keysShown = keysOn || kbVisible;
  const toggleKeys = useCallback(() => {
    const next = !keysShown;
    persistKeys(next);
    if (lineShownRef.current) {
      // Touch phone: the keyboard comes up on the command line.
      if (next) cmdRef.current?.focus();
      else cmdRef.current?.blur();
      return;
    }
    applySoftKb(next);
  }, [keysShown, persistKeys, applySoftKb]);
  const hideKeyboard = useCallback(() => {
    persistKeys(false);
    cmdRef.current?.blur();
    applySoftKb(false);
  }, [persistKeys, applySoftKb]);
  // The command line's keyboard icon: type live, straight into the session.
  const goLive = useCallback(() => {
    setLiveTyping(true);
    persistKeys(true);
    applySoftKb(true);
  }, [persistKeys, applySoftKb]);
  // One command from the line: the text (paste-wrapped when the program asked
  // for bracketed paste), then Enter a beat later so Claude Code reads the
  // Enter as Send, not as a newline inside the paste.
  const sendLine = useCallback((text: string) => {
    if (text) {
      const bracketed = terminalRef.current?.modes.bracketedPasteMode ?? false;
      sendInput(wrapForPaste(text, bracketed));
      setTimeout(() => sendInput('\r'), 60);
    } else {
      sendInput('\r');
    }
  }, [sendInput]);

  // ------------------------------------------------------------------
  // Switching sessions slides. The outgoing terminal's own canvas is kept
  // on screen (moved into the ghost layer) until the incoming session has
  // painted, then it drops out in 90ms while the new one slides 24px in
  // over 200ms. Never through an empty frame. Input is live at once.
  // ------------------------------------------------------------------
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostTermRef = useRef<{ term: Terminal; timer: ReturnType<typeof setTimeout> } | null>(null);
  const slideDirRef = useRef(0);
  const [titleSlide, setTitleSlide] = useState(0);
  const revealRef = useRef<(() => void) | null>(null);
  const headerTitleRef = useRef<HTMLDivElement>(null);
  const swipedRef = useRef(false);
  const swipeResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringRef = useRef<string[]>([]);
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** The swipe order: frozen as sessions appear, so a position never moves under you. */
  const ring = useCallback((): string[] => {
    const list = useAppStore.getState().sessions;
    const ids = new Set(list.map((s) => s.id));
    const cur = ringRef.current.filter((id) => ids.has(id));
    for (const s of orderSessions(list)) if (!cur.includes(s.id)) cur.push(s.id);
    ringRef.current = cur;
    return cur;
  }, []);

  const clearSwipeVisual = useCallback((animate: boolean) => {
    const els = [headerTitleRef.current?.querySelector<HTMLElement>('.pl-ph-t'), termRef.current];
    for (const el of els) {
      if (!el || !el.style.transform) continue;
      const from = el.style.transform;
      const fromOpacity = el.style.opacity || '1';
      el.style.transform = '';
      el.style.opacity = '';
      if (animate && !reducedMotion()) {
        el.animate([{ transform: from, opacity: fromOpacity }, { transform: 'none', opacity: 1 }], { duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    }
  }, []);

  const switchTo = useCallback((id: string, dir?: number) => {
    const app = useAppStore.getState();
    if (!id || id === app.attachedSession?.id) return;
    const list = ring();
    const d = dir ?? (list.indexOf(id) > list.indexOf(app.attachedSession?.id ?? '') ? 1 : -1);
    slideDirRef.current = d;
    setTitleSlide(d);
    setFlash(null);
    app.attachSession(id);
    // An attach that never answers must not leave the screen pulled aside.
    if (swipeResetRef.current) clearTimeout(swipeResetRef.current);
    swipeResetRef.current = setTimeout(() => clearSwipeVisual(true), 1500);
  }, [ring, clearSwipeVisual]);

  const stepSession = useCallback((d: number): boolean => {
    const list = ring();
    const cur = useAppStore.getState().attachedSession?.id ?? '';
    if (list.length < 2) return false;
    const i = list.indexOf(cur);
    const j = i < 0 ? 0 : (i + d + list.length) % list.length;
    switchTo(list[j], d);
    return true;
  }, [ring, switchTo]);

  const swipeMove = useCallback((dx: number) => {
    if (reducedMotion()) return;
    const t = headerTitleRef.current?.querySelector<HTMLElement>('.pl-ph-t');
    if (t) t.style.transform = `translateX(${dx * 0.4}px)`;
    const c = termRef.current;
    if (c) {
      c.style.transform = `translateX(${dx * 0.15}px)`;
      c.style.opacity = String(1 - Math.min(Math.abs(dx) / 400, 0.35));
    }
  }, []);
  const swipeEnd = useCallback((dx: number, threshold: number) => {
    swipedRef.current = true;
    setTimeout(() => { swipedRef.current = false; }, 60);
    if (Math.abs(dx) > threshold && stepSession(dx < 0 ? 1 : -1)) return;
    clearSwipeVisual(true);
  }, [stepSession, clearSwipeVisual]);
  const swipeRef = useRef({ move: swipeMove, end: swipeEnd });
  swipeRef.current = { move: swipeMove, end: swipeEnd };

  // The title swipes too (pointer events; the terminal's touch engine has its own).
  useEffect(() => {
    const el = headerTitleRef.current;
    if (!el) return;
    let x0 = 0; let y0 = 0; let dx = 0; let id: number | null = null; let lock: 'x' | 'y' | null = null;
    const down = (e: PointerEvent) => {
      if (e.button) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0; lock = null; id = e.pointerId;
    };
    const move = (e: PointerEvent) => {
      if (id !== e.pointerId) return;
      const ddx = e.clientX - x0;
      const ddy = e.clientY - y0;
      if (!lock) {
        if (Math.abs(ddx) > 12 && Math.abs(ddx) > Math.abs(ddy) * 1.5) {
          lock = 'x';
          try { el.setPointerCapture(e.pointerId); } catch { /* optional */ }
        } else if (Math.abs(ddy) > 10) lock = 'y';
      }
      if (lock !== 'x') return;
      dx = ddx;
      swipeRef.current.move(dx);
    };
    const up = (e: PointerEvent) => {
      if (id !== e.pointerId) return;
      id = null;
      if (lock === 'x') swipeRef.current.end(dx, 56);
      lock = null;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, []);

  // A new session on screen: the old one's sheets and drafts never follow it.
  useEffect(() => {
    setComposer(null);
    setPrompt(null);
    setClaudeTab(null);
    if (swipeResetRef.current) { clearTimeout(swipeResetRef.current); swipeResetRef.current = null; }
    const t = headerTitleRef.current?.querySelector<HTMLElement>('.pl-ph-t');
    if (t) { t.style.transform = ''; t.style.opacity = ''; }
  }, [attachedSession?.id]);

  /** Drop the ghost and slide the new terminal in. */
  const reveal = useCallback((dir: number) => {
    const entry = ghostTermRef.current;
    ghostTermRef.current = null;
    const ghost = ghostRef.current;
    const live = termRef.current;
    const rm = reducedMotion();
    const dx = dir * 24;
    if (ghost && entry) {
      const from = { transform: ghost.style.transform || 'none', opacity: ghost.style.opacity || '1' };
      const anim = rm
        ? ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'forwards' })
        : ghost.animate([
          { opacity: Number(from.opacity), transform: from.transform },
          { opacity: 0.12, transform: `translateX(${-dx * 0.5}px)`, offset: 0.3 },
          { opacity: 0, transform: `translateX(${-dx}px)`, offset: 0.6 },
          { opacity: 0, transform: `translateX(${-dx}px)` },
        ], { duration: 90, easing: 'linear', fill: 'forwards' });
      setTimeout(() => {
        clearTimeout(entry.timer);
        entry.term.dispose();
        if (ghostRef.current === ghost && !ghostTermRef.current) {
          ghost.replaceChildren();
          ghost.style.transform = '';
          ghost.style.opacity = '';
        }
        anim.cancel();
      }, 100);
    }
    if (live) {
      live.animate(
        rm || !dx
          ? [{ opacity: 0.4 }, { opacity: 1 }]
          : [{ opacity: 0.4, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }],
        { duration: rm ? 120 : dx ? 200 : 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }
  }, []);

  // Handle output events — only write if sessionId matches, otherwise buffer
  // until the matching terminal mounts (covers the attach handshake window).
  const handleOutput = useCallback((e: Event) => {
    const { data, sessionId } = (e as CustomEvent).detail;
    if (terminalRef.current && sessionId === sessionIdRef.current) {
      // The first paint of a session just switched to retires the ghost.
      const fire = revealRef.current;
      if (fire) terminalRef.current.write(data, () => requestAnimationFrame(fire));
      else terminalRef.current.write(data);
    } else {
      const buf = pendingOutputRef.current;
      buf.push({ data, sessionId });
      // Cap the buffer. In steady state the server streams only the attached
      // session, so this only fills during a brief switch race and drains on
      // remount — but a stray broadcast of a non-attached session while the
      // user sits on one session for hours would otherwise grow it without
      // bound (raw terminal bytes). Keep only the most recent entries.
      if (buf.length > 500) buf.splice(0, buf.length - 500);
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

    // Style comes from the shared store — mobile was hardcoded to one look
    // while desktop panes were themeable; now both follow the same settings.
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

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // A tap on a visible URL opens it. OSC 8 hyperlinks (which programs mark
    // up themselves, and which stay one link across wrapped rows) can show
    // text that differs from their target, so a tap on one surfaces the real
    // URL in the open-link toast first; one more tap opens it.
    term.loadAddon(new WebLinksAddon((_e, uri) => { openExternal(uri); }));
    term.options.linkHandler = {
      activate: (_e, uri) => { promptOpen(uri); },
      allowNonHttpProtocols: false,
    };
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    const searchResultsDisp = searchAddon.onDidChangeResults((e) => {
      setSearchCount(e.resultCount >= 0 ? { current: e.resultIndex + 1, total: e.resultCount } : null);
    });

    term.open(termRef.current);

    // Apply the soft-keyboard policy to this terminal's textarea (a new
    // textarea is born with every terminal instance).
    if (term.textarea) {
      term.textarea.inputMode = resolveInputMode(softKbOnRef.current);
    }

    // OSC 52 passthrough: programs inside the session (tmux copy-mode `y`,
    // vim yank plugins, CLIs) push text straight onto this device's clipboard.
    // Write-only — clipboard READ queries ("?") are never answered.
    const osc52Disp = term.parser.registerOscHandler(52, handleOsc52);

    // Try WebGL, fall back gracefully. Mobile browsers (Android especially)
    // evict GPU contexts from backgrounded tabs/PWAs; without a context-loss
    // handler the canvas stays permanently blank after reopening the app —
    // output keeps arriving but is drawn into a dead context. On loss we
    // dispose the addon (xterm swaps back to the DOM renderer and repaints),
    // and try to re-acquire WebGL next time the tab becomes visible.
    let webgl: WebglAddon | null = null;
    const loadWebgl = () => {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          webgl = null;
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch {
        webgl = null; /* DOM renderer fallback */
      }
    };
    loadWebgl();
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!webgl) loadWebgl();
      // Repaint unconditionally — a context lost while backgrounded can leave
      // stale or blank pixels even after the renderer swap.
      term.refresh(0, term.rows - 1);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    fitAddon.fit();

    // Send initial size to server
    resize(term.cols, term.rows);

    // Came from another session: hold its frame (the ghost) until this one
    // paints its first output, or 450ms at most.
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    if (ghostTermRef.current) {
      const dir = slideDirRef.current;
      slideDirRef.current = 0;
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        if (revealTimer) clearTimeout(revealTimer);
        if (revealRef.current === fire) revealRef.current = null;
        reveal(dir);
      };
      revealRef.current = fire;
      revealTimer = setTimeout(fire, 450);
    }

    // Live-apply style changes (theme swatch taps, pinch-zoom font size…)
    // without re-attaching. Mirrors TerminalPane's subscription.
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
        requestAnimationFrame(() => {
          try {
            fitAddon.fit();
            resize(term.cols, term.rows);
          } catch { /* detached mid-change */ }
        });
      }
    });
    saveDims(term.cols, term.rows);

    // NOTE: Don't write initialScrollback here. The PTY bridge (tmux attach)
    // redraws the full screen with proper ANSI escape sequences. Writing the
    // plain-text scrollback first causes double-rendering and cursor corruption.

    // Flush output that arrived before terminal was ready, filtered by session
    terminalRef.current = term;
    if (pendingOutputRef.current.length > 0) {
      const targetId = sessionIdRef.current;
      let wrote = false;
      for (const entry of pendingOutputRef.current) {
        if (entry.sessionId === targetId) {
          term.write(entry.data);
          wrote = true;
        }
      }
      pendingOutputRef.current = [];
      const fire = revealRef.current;
      if (wrote && fire) term.write('', () => requestAnimationFrame(fire));
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
    // Success is silent — copy toasts were noise (user call, 2026-08-14).
    // Only a BLOCKED copy speaks up, because that one needs the user to act.
    const clipboardWrite = (text: string) => {
      if (!text) return;
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
          () => undefined,
          () => {
            if (!legacyCopy(text)) notify('error', 'Copy blocked by browser');
          },
        );
        return;
      }
      if (!legacyCopy(text)) notify('error', 'Copy blocked by browser');
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
    // Mouse only: desktop drag-select auto-copies (terminal convention).
    // Touch selections do NOT — Android blocks clipboard writes outside a
    // fresh user gesture so it silently failed half the time; on mobile the
    // native long-press selection menu (Copy) is the way.
    document.addEventListener('mouseup', onSelectionEnd);

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
        // execCommand('paste') is a no-op in modern browsers (security);
        // the async Clipboard API is the path that actually works. Keep
        // execCommand only as a legacy fallback.
        if (navigator.clipboard?.readText && window.isSecureContext) {
          navigator.clipboard.readText().then(
            (text) => { if (text) sendInput(text); },
            () => notify('error', 'Paste blocked — allow clipboard access for this site.'),
          );
        } else {
          document.execCommand('paste');
        }
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
    // Swipe-typing auto-space: re-adds the between-word space that glide
    // keyboards omit because the cleared helper textarea gives them no
    // before-cursor context. See lib/swipeAutoSpace.ts.
    const autoSpacer = createSwipeAutoSpacer();
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
      textarea.addEventListener('compositionend', () => { autoSpacer.noteCompositionEnd(); clearComposing(); });
      // A (re)focus must always yield a typable terminal — clear any stuck
      // composition and reset the delta tracker so a wedged session recovers.
      textarea.addEventListener('focus', () => { clearComposing(); sentSoFar = ''; autoSpacer.reset(); });
      textarea.addEventListener('blur', () => { clearComposing(); sentSoFar = ''; autoSpacer.reset(); });
      // Suppress mobile keyboard suggestions / browser autocomplete on the
      // hidden input — reduces trigger frequency for the bug above.
      textarea.setAttribute('autocomplete', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('autocapitalize', 'none');
      textarea.setAttribute('spellcheck', 'false');
    }

    let lastConnWarn = 0;
    term.onData((data) => {
      if (composing) return;

      // Real typing arrives via onData (touch-scroll is a separate path), so a
      // keystroke means the user is back at work — hide the jump button. The
      // server cancels copy-mode for printable input on its side.
      setScrolledUp(false);
      altUpLinesRef.current = 0;

      // Typing while the socket is down would silently vanish — warn (throttled)
      // so it doesn't feel like the earlier "can't type" bugs.
      if (useAppStore.getState().connectionState !== 'authenticated') {
        const now = performance.now();
        if (now - lastConnWarn > 3000) {
          lastConnWarn = now;
          useAppStore.getState().pushNotification('error', 'Not connected — keystroke not sent.', 'conn');
        }
      }

      const forward = (chunk: string) => {
        // Sticky Ctrl from the key bar: the next typed letter becomes its
        // control code (Ctrl+A…Z), then the modifier disarms.
        if (ctrlArmedRef.current && /^[a-zA-Z]$/.test(chunk)) {
          ctrlArmedRef.current = false;
          setCtrlArmed(false);
          sendInput(String.fromCharCode(chunk.toUpperCase().charCodeAt(0) - 64));
          return;
        }
        sendInput(autoSpacer.process(chunk));
      };
      if (data.length > sentSoFar.length && sentSoFar && data.startsWith(sentSoFar)) {
        const delta = data.slice(sentSoFar.length);
        if (delta) forward(delta);
      } else if (data.length < sentSoFar.length && sentSoFar.startsWith(data)) {
        const removed = sentSoFar.length - data.length;
        for (let i = 0; i < removed; i++) forward('\x7f');
      } else {
        forward(data);
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
    // Titan keyboard-swipe support: Scroll Assistant injects short synthetic
    // drags, each its own touch gesture. One that stays under LINE_PX would
    // truncate to zero lines and the whole swipe scrolls nothing — so a
    // drag that ends having emitted nothing flushes its remainder as one
    // line (FLUSH_MIN_PX floor keeps jitter from scrolling), and anything
    // smaller carries into the next gesture if it starts within CARRY_MS.
    let emittedInGesture = false;
    let microCarry = false;
    let lastGestureEndAt = 0;
    const FLUSH_MIN_PX = 6;
    const CARRY_MS = 300;
    const LINE_PX = 18;
    const FRICTION_PER_16MS = 0.94; // slightly less than 1 → exponential decay
    const STOP_THRESHOLD_PX_PER_MS = 0.04; // stop momentum below this
    const FLING_THRESHOLD_PX_PER_MS = 0.25; // ignore stationary lifts
    const container = termRef.current;

    const applyScroll = (rawLines: number, useGain = true) => {
      if (rawLines === 0) return;
      // Gain for devices that inject tiny synthetic drags (Titan keyboard
      // swipe ≈ 35px ≈ 1 line at 1×). Applies to drags AND momentum — but
      // NOT to end-of-gesture flushes, where gain would turn a 6px finger
      // twitch into a multi-line jump.
      const lines = rawLines * (useGain ? useTerminalStyleStore.getState().scrollGain || 1 : 1);
      pushDebug(`→ scroll ${lines > 0 ? 'down' : 'up'} ${Math.abs(lines)}l ${term.buffer.active.type === 'alternate' ? '(alt)' : ''}`);
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
        // alt-screen owns its buffer, so we can't read the real scroll
        // position — track net up-lines instead. Down-scroll pays the count
        // back off; at zero the user is back at (or past) live, so the jump
        // button clears without requiring a keystroke.
        altUpLinesRef.current = Math.max(0, altUpLinesRef.current - lines);
        if (altUpLinesRef.current === 0) setScrolledUp(false);
        else if (performance.now() >= suppressRearmUntilRef.current) setScrolledUp(true);
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
    cancelMomentumRef.current = cancelMomentum;
    altUpLinesRef.current = 0;

    // ------------------------------------------------------------------
    // Suggestion bar: when the server echo lands (onWriteParsed), read the
    // cursor line, strip the prompt, and prefix-match shell history. All
    // matching is local against the once-per-auth history snapshot — no
    // per-keystroke round-trips. Requiring a prompt marker keeps streaming
    // output from being mistaken for typed input.
    let suggTimer: ReturnType<typeof setTimeout> | null = null;
    const updateSuggestions = () => {
      const clear = () => setSugg((s) => (s.items.length || s.prefix ? { prefix: '', items: [] } : s));
      // NOTE: no alt-screen check — tmux keeps the outer terminal in the
      // alternate buffer permanently, so that signal is useless here. The
      // shell-prompt-marker requirement below is the real gate (and the
      // marker list deliberately excludes '> ' so Claude Code's input line
      // never triggers shell-history suggestions).
      const buf = term.buffer.active;
      // Rebuild the full LOGICAL line: on phone-width terminals the prompt +
      // command wraps, putting the cursor on a continuation row whose text
      // alone has no prompt marker. Walk back through isWrapped rows.
      let row = buf.baseY + buf.cursorY;
      let line = buf.getLine(row)?.translateToString(false, 0, buf.cursorX) ?? '';
      while (row > 0 && buf.getLine(row)?.isWrapped) {
        row--;
        line = (buf.getLine(row)?.translateToString(false) ?? '') + line;
      }
      let start = 0;
      for (const marker of ['$ ', '# ', '% ', '❯ ']) {
        const i = line.lastIndexOf(marker);
        if (i >= 0 && i + marker.length > start) start = i + marker.length;
      }
      const typed = line.slice(start).replace(/^\s+/, '');
      if (start === 0 || typed.length < 2) { clear(); return; }
      const history = useAppStore.getState().shellHistory;
      const items: string[] = [];
      for (const cmd of history) {
        if (cmd.startsWith(typed) && cmd !== typed) {
          items.push(cmd);
          if (items.length >= 5) break;
        }
      }
      setSugg({ prefix: typed, items });
    };
    const writeParsedDisp = term.onWriteParsed(() => {
      if (suggTimer) clearTimeout(suggTimer);
      suggTimer = setTimeout(updateSuggestions, 120);
      if (watchPromptRef.current) schedulePromptRef.current();
    });

    // ------------------------------------------------------------------
    // Reader mirror — OS-native selection (lib/readerMirror.ts). xterm is a
    // canvas, so a touch that holds still lays a transparent DOM copy of the
    // buffer over it; Android's own long-press then lands on real text and
    // brings its own handles and Copy / Share / Select-all toolbar. The copy
    // becomes an opaque frozen page the moment a selection exists and goes
    // away when that selection collapses (tap, Copy) or the touch turns into
    // a scroll. Nothing in it is editable: select and copy, never move.
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const reader = new ReaderMirror(term, container);
    readerRef.current = reader;
    let readerTeardown: ReturnType<typeof setTimeout> | null = null;
    const cancelReaderTeardown = () => {
      if (readerTeardown !== null) clearTimeout(readerTeardown);
      readerTeardown = null;
    };
    // Promote the transparent hit target to the visible page as soon as the
    // OS puts a selection in it; retire it once that selection is gone.
    const syncReader = () => {
      if (!reader.active) return;
      if (reader.hasSelection()) {
        cancelReaderTeardown();
        if (!reader.isRevealed) {
          reader.reveal();
          term.blur(); // reading mode: keyboard down, handles unobstructed
          try { navigator.vibrate?.(15); } catch { /* unsupported */ }
        }
        // The OS's Select all spans the page; keep it on the terminal text.
        reader.clampSelection();
      } else if (reader.isRevealed && readerTeardown === null) {
        // Debounced — selectionchange can report collapsed transiently.
        readerTeardown = setTimeout(() => {
          readerTeardown = null;
          if (!reader.hasSelection()) reader.dispose();
        }, 150);
      }
    };
    document.addEventListener('selectionchange', syncReader);
    const disposeReader = () => {
      cancelReaderTeardown();
      reader.dispose();
    };
    // A long-press fires contextmenu on Android. Swallow it on the bare
    // canvas (nothing useful lives there) — but NEVER while the mirror is
    // armed: preventDefault there is exactly what cancels OS text selection.
    const onContextMenu = (e: Event) => { if (coarsePointer && !reader.active) e.preventDefault(); };
    container.addEventListener('contextmenu', onContextMenu);
    container.addEventListener('contextmenu', onContextMenu);

    // ------------------------------------------------------------------
    // Gesture engine (Termius-style spec). One meaning per gesture, no modes:
    //   plain drag                 → scroll (with momentum fling)
    //   two-finger pinch           → font size (live, persisted)
    //   double-tap                 → Tab (completion; toggleable in settings)
    //   hold (still)               → OS text selection (reader mirror)
    // The arrow-key joystick that used to live on long-press moved to a
    // hold-and-drag on the quick-actions FAB.
    const TAP_MAX_MS = 250;
    const ARM_MS = 120; // well ahead of Android's own ~500ms long-press
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    // The touch is not a hold after all: drop the timer and any hit target
    // that never received a selection.
    const disarmReader = () => {
      cancelLongPress();
      if (reader.active && !reader.isRevealed) disposeReader();
    };
    const TAP_SLOP_PX = 12;
    const DOUBLE_TAP_GAP_MS = 300;
    const DOUBLE_TAP_RADIUS_PX = 40;

    let touchStartX = 0;
    let touchStartTime = 0;
    let tapCandidate = false;
    let lastTapEnd = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let pinching = false;
    let pinchStartDist = 0;
    let pinchStartSize = 0;
    // A sideways drag slides to the next or previous session. It locks after
    // 14px when clearly horizontal; a vertical drag stays a scroll.
    let swipeLock: 'x' | 'y' | null = null;
    let swipeDx = 0;
    const SWIPE_COMMIT_PX = 72;

    // Pending tap-away keyboard dismiss (see the tap handler below).
    let kbDismissTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelKbDismiss = () => {
      if (kbDismissTimer !== null) {
        clearTimeout(kbDismissTimer);
        kbDismissTimer = null;
      }
    };
    // Was the tap on (±1 row of) the cursor's line — the de-facto input field?
    const tapOnCursorRow = () => {
      const screen = term.element?.querySelector('.xterm-screen');
      if (!screen) return false;
      const rect = screen.getBoundingClientRect();
      const cellH = rect.height / term.rows;
      if (cellH <= 0) return false;
      const tappedRow = Math.floor((touchStartY - rect.top) / cellH);
      const buf = term.buffer.active;
      return Math.abs(tappedRow - (buf.baseY + buf.cursorY - buf.viewportY)) <= 1;
    };
    const touchDist = (e: TouchEvent) => Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY,
    );

    const onTouchStart = (e: TouchEvent) => {
      if (reader.isRevealed) return; // native page: taps, scrolls, handles are the OS's
      cancelMomentum();
      cancelKbDismiss(); // a second tap (double-tap Tab) keeps the keyboard up
      disarmReader();
      if (e.touches.length >= 2) {
        // Second finger down → pinch. Kill every single-finger gesture state.
        tapCandidate = false;
        pinching = true;
        pinchStartDist = touchDist(e);
        pinchStartSize = useTerminalStyleStore.getState().fontSize;
        return;
      }
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      swipeLock = null;
      swipeDx = 0;
      lastMoveY = touchStartY;
      lastMoveTime = performance.now();
      touchStartTime = lastMoveTime;
      // Keep the remainder only when chaining off a sub-line micro-swipe;
      // after a normal scroll or a long gap, start clean as before.
      if (!(microCarry && lastMoveTime - lastGestureEndAt < CARRY_MS)) scrollAccum = 0;
      microCarry = false;
      emittedInGesture = false;
      velocity = 0;
      tapCandidate = true;
      // Hold still → arm the reader mirror under the finger, ahead of the OS
      // long-press that will select on it. Cancelled by movement past the
      // tap slop (a scroll), a second finger, or lift.
      const sx = touchStartX;
      const sy = touchStartY;
      if (coarsePointer) {
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (!tapCandidate || !reader.overGrid(sx, sy)) return;
          reader.arm();
        }, ARM_MS);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (reader.isRevealed) return;
      if (pinching) {
        // Swallow all moves while the pinch flag is up — including the tail
        // where one finger lifted — so the leftover finger can't scroll-jump.
        if (e.touches.length >= 2 && pinchStartDist > 0) {
          const scale = touchDist(e) / pinchStartDist;
          useTerminalStyleStore.getState().setFontSize(pinchStartSize * scale);
        }
        return;
      }
      const now = performance.now();
      const t = e.touches[0];
      const y = t.clientY;

      if (!swipeLock) {
        const ddx = t.clientX - touchStartX;
        const ddy = y - touchStartY;
        if (Math.abs(ddx) > 14 && Math.abs(ddx) > Math.abs(ddy) * 1.5) swipeLock = 'x';
        else if (Math.abs(ddy) > 10) swipeLock = 'y';
      }
      if (swipeLock === 'x') {
        if (tapCandidate) { tapCandidate = false; disarmReader(); }
        swipeDx = t.clientX - touchStartX;
        swipeRef.current.move(swipeDx);
        return;
      }

      if (tapCandidate
        && Math.hypot(t.clientX - touchStartX, y - touchStartY) > TAP_SLOP_PX) {
        tapCandidate = false;
        disarmReader(); // it's a scroll
      }
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
        emittedInGesture = true;
        applyScroll(lines);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (pinching) {
        if (e.touches.length === 0) pinching = false;
        velocity = 0;
        return;
      }
      cancelLongPress();
      if (swipeLock === 'x') {
        swipeLock = null;
        velocity = 0;
        swipeRef.current.end(swipeDx, SWIPE_COMMIT_PX);
        return;
      }
      // The OS selection may have landed before its selectionchange task ran
      // — check directly so this lift isn't mistaken for a tap or a fling.
      syncReader();
      if (reader.isRevealed) {
        tapCandidate = false;
        velocity = 0;
        return;
      }
      disarmReader();
      // Double-tap → Tab. Two quick, still taps close together.
      const now = performance.now();
      if (tapCandidate && now - touchStartTime < TAP_MAX_MS) {
        const withinGap = now - lastTapEnd < DOUBLE_TAP_GAP_MS + TAP_MAX_MS;
        const withinRadius = Math.hypot(touchStartX - lastTapX, touchStartY - lastTapY) < DOUBLE_TAP_RADIUS_PX;
        if (withinGap && withinRadius && useTerminalStyleStore.getState().doubleTapTab) {
          lastTapEnd = 0; // consume — a third tap starts fresh
          try { navigator.vibrate?.(10); } catch { /* unsupported */ }
          sendInput('\t');
          velocity = 0;
          return;
        }
        lastTapEnd = now;
        lastTapX = touchStartX;
        lastTapY = touchStartY;
        // Tap on the cursor's line = tapping the "input field" → raise the
        // keyboard; tap anywhere else → hide it. The terminal is a character
        // grid with no real input box, but the cursor row is where typing
        // lands (a shell prompt, Claude Code's input box). ±1 row of slop
        // covers box borders + fat fingers. The hide is DELAYED past the
        // double-tap window and canceled by the next touchstart — otherwise
        // the first tap of a double-tap-Tab (used mid-typing) would yank the
        // keyboard down before the Tab even fired.
        if (tapOnCursorRow()) {
          // Touch phones: the command line is where typing goes.
          // xterm's own mousedown (fired after this touchend) grabs focus
          // back, so the click handler below does the focusing.
          if (lineShownRef.current) cmdTapAtRef.current = performance.now();
          else if (!softKbOnRef.current) applySoftKb(true);
        } else if (softKbOnRef.current) {
          kbDismissTimer = setTimeout(() => {
            kbDismissTimer = null;
            applySoftKb(false);
          }, DOUBLE_TAP_GAP_MS);
        }
      }
      // If the finger was essentially stopped before lift, no fling.
      // Stale velocity from earlier in the gesture also gets dropped if
      // the last few ms were quiet (touchmove not fired recently).
      const idleSinceLastMove = performance.now() - lastMoveTime;
      if (idleSinceLastMove > 80 || Math.abs(velocity) < FLING_THRESHOLD_PX_PER_MS) {
        velocity = 0;
        lastGestureEndAt = performance.now();
        if (!tapCandidate && !emittedInGesture && scrollAccum !== 0) {
          if (Math.abs(scrollAccum) >= FLUSH_MIN_PX) {
            pushDebug('→ flush sub-line swipe');
            applyScroll(Math.sign(scrollAccum), false);
            scrollAccum = 0;
          } else {
            microCarry = true;
          }
        }
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

    // Desktop scroll-up detection. When an alt-screen app owns the mouse
    // (Claude Code, vim, less), xterm forwards the wheel straight to the app
    // and never fires its own scroll events — so the touch-path `scrolledUp`
    // flag never trips and the "Jump to live" button never appears on desktop.
    // Observe wheel direction passively (xterm still forwards the event) so the
    // button surfaces here too. Same net-lines proxy as the touch path, so
    // wheeling back down to live clears the button without a keystroke.
    const onWheel = (e: WheelEvent) => {
      if (term.buffer.active.type !== 'alternate' || e.deltaY === 0) return;
      const wheelLines = Math.max(1, Math.round(Math.abs(e.deltaY) / LINE_PX));
      altUpLinesRef.current = Math.max(
        0,
        altUpLinesRef.current + (e.deltaY < 0 ? wheelLines : -wheelLines),
      );
      if (altUpLinesRef.current === 0) setScrolledUp(false);
      else if (performance.now() >= suppressRearmUntilRef.current) setScrolledUp(true);
    };
    container.addEventListener('wheel', onWheel, { passive: true });

    // One-time select hint. With Claude holding the mouse, a plain drag goes to
    // Claude instead of selecting text. The first time the user tries to
    // drag-select in an alt-screen mouse app, point them at the two ways that
    // still work: Shift+drag, or the "select" icon (native copy modal).
    let selectHintShown = (() => {
      try { return localStorage.getItem('persalink-select-hint-seen') === 'true'; }
      catch { return false; }
    })();
    let dragCandidate = false;
    const onMouseDownHint = (e: MouseEvent) => {
      // Real-mouse devices only. Android synthesizes mouse events after taps,
      // which fired this hint on phones — where "Shift+drag" is impossible.
      dragCandidate = !e.shiftKey && term.buffer.active.type === 'alternate'
        && window.matchMedia('(pointer: fine)').matches;
    };
    const onMouseMoveHint = () => {
      if (!dragCandidate || selectHintShown) return;
      dragCandidate = false;
      selectHintShown = true;
      try { localStorage.setItem('persalink-select-hint-seen', 'true'); } catch { /* private mode */ }
      try {
        useAppStore.getState().pushNotification(
          'info',
          'Claude is using the mouse here — Shift+drag to select text, or tap the select icon to copy output.',
          'selecthint',
        );
      } catch { /* store unavailable */ }
    };
    const onMouseUpHint = () => { dragCandidate = false; };
    container.addEventListener('mousedown', onMouseDownHint);
    container.addEventListener('mousemove', onMouseMoveHint);
    container.addEventListener('mouseup', onMouseUpHint);

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
      const shrunk = term.rows < lastRows;
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        saveDims(term.cols, term.rows);
        disposeReader(); // the snapshot would point at reflowed content
      }
      // Always re-send, even when the grid didn't change. A resize message can
      // be lost server-side (it races the async attach flow) or client-side
      // (WS reconnect window); the grid then never changes again while the
      // keyboard is up, so a change-gated send would leave tmux at the stale
      // size for the whole typing session — bottom rows (the input box) clamp
      // onto xterm's last line and the status bar overprints them.
      resize(term.cols, term.rows);
      // Keyboard opening = rows shrink. Land at the prompt, not mid-scrollback.
      if (shrunk) term.scrollToBottom();
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

    // Focus = the user is about to type (and on mobile, the keyboard is about
    // to open). Schedule a reconciling fit so tmux and xterm agree on size at
    // exactly the moment a stale size would hide the input box. The shared
    // debounce timer means the visualViewport events that follow simply push
    // this back until the keyboard animation settles.
    const onTermFocus = () => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(doFit, RESIZE_DEBOUNCE_MS + 150);
    };
    term.textarea?.addEventListener('focus', onTermFocus);

    // Re-fit after layout settles — triple pass: immediate rAF, delayed rAF,
    // and a timer to catch slow CSS transitions or conditional bar changes.
    requestAnimationFrame(() => requestAnimationFrame(doFit));
    setTimeout(doFit, 200);

    // Auto-focus terminal after mount + any pending click events resolve.
    requestAnimationFrame(() => term.focus());
    setTimeout(() => term.focus(), 150);

    return () => {
      cancelMomentum();
      cancelMomentumRef.current = null;
      unsubStyle();
      cancelLongPress();
      disposeReader();
      readerRef.current = null;
      document.removeEventListener('selectionchange', syncReader);
      container.removeEventListener('contextmenu', onContextMenu);
      osc52Disp.dispose();
      searchResultsDisp.dispose();
      searchAddonRef.current = null;
      writeParsedDisp.dispose();
      if (suggTimer) clearTimeout(suggTimer);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('mousedown', onMouseDownHint);
      container.removeEventListener('mousemove', onMouseMoveHint);
      container.removeEventListener('mouseup', onMouseUpHint);
      container.removeEventListener('paste', onPaste as EventListener);
      document.removeEventListener('mouseup', onSelectionEnd);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      selectionChangeDisposable.dispose();
      resizeObserver.disconnect();
      window.visualViewport?.removeEventListener('resize', onViewportResize);
      term.textarea?.removeEventListener('focus', onTermFocus);
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      if (compositionWatchdog) clearTimeout(compositionWatchdog);
      cancelKbDismiss();
      if (revealTimer) clearTimeout(revealTimer);
      revealRef.current = null;
      terminalRef.current = null;
      // Switching to another session (the screen stays): keep this frame on
      // screen as the ghost until the next one paints. Unmounting: just go.
      const ghost = ghostRef.current;
      const el = term.element;
      if (ghost && ghost.isConnected && el) {
        const prev = ghostTermRef.current;
        if (prev) { clearTimeout(prev.timer); prev.term.dispose(); }
        ghost.getAnimations().forEach((a) => a.cancel());
        ghost.replaceChildren(el);
        ghost.style.transform = container.style.transform;
        ghost.style.opacity = container.style.opacity;
        container.style.transform = '';
        container.style.opacity = '';
        // Safety net: a reveal that never comes still frees the old terminal.
        ghostTermRef.current = { term, timer: setTimeout(() => { if (ghostTermRef.current?.term === term) reveal(0); }, 1500) };
      } else {
        term.dispose();
      }
    };
  }, [attachedSession?.id]);

  // The palette and the keyboard reach this terminal through pane commands
  // (lib/paneCommands), addressed to PHONE_TERMINAL.
  const paneRef = useRef({ answer, openComposer, stepSession });
  paneRef.current = { answer, openComposer, stepSession };
  useEffect(() => {
    const onCommand = (e: Event) => {
      const { paneId, command, data } = (e as CustomEvent<PaneCommandDetail>).detail;
      if (paneId !== PHONE_TERMINAL) return;
      const app = useAppStore.getState();
      if (command === 'step') {
        // Alt+[ / Alt+]: the same ring and the same slide as a swipe.
        if (!paneRef.current.stepSession(data === '-1' ? -1 : 1)) return;
        e.preventDefault();
        return;
      }
      if (!app.attachedSession || app.endedSession) return;
      switch (command) {
        case 'composer': paneRef.current.openComposer({ listen: false }); break;
        case 'links': requestLinks(); break;
        case 'claude': setClaudeTab('copy'); break;
        case 'upload': if (filesDisabled) return; fileInputRef.current?.click(); break;
        case 'snippets': setShowSnippets(true); break;
        case 'find': setShowSearch(true); break;
        case 'terminal-settings': setShowStyleSheet(true); break;
        case 'insert':
          if (!data) return;
          sendInput(data);
          terminalRef.current?.focus();
          break;
        case 'answer': {
          const option = data && terminalRef.current ? promptOnScreen(terminalRef.current)?.options.find((o) => o.key === data) : undefined;
          if (!option) return;
          paneRef.current.answer(option);
          break;
        }
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener(PANE_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(PANE_COMMAND_EVENT, onCommand);
  }, [requestLinks, sendInput, filesDisabled]);

  // A hardware keyboard (the Titan) gets the invisible Alt set and digit
  // answers; nothing is drawn for it.
  useGlobalShortcuts({ variant: 'phone', enabled: hwKeyboard });

  // More: the terminal's less frequent tools, and the one place the phone
  // lists its keyboard shortcuts.
  const [showMore, setShowMore] = useState(false);
  const openTextView = () => {
    const r = readerRef.current;
    if (!r) return;
    if (r.active) r.dispose();
    else if (r.open()) terminalRef.current?.blur();
  };
  const moreItems: MenuItem[] = [
    { id: 'message', icon: <MessageSquare />, label: 'Write a message', sub: 'a box with a mic: edit, then send', run: () => openComposer({ listen: false }) },
    { id: 'upload', icon: <Paperclip />, label: 'Attach a file', sub: title ? `uploads it and types the path into ${title}` : undefined, hidden: filesDisabled, run: () => fileInputRef.current?.click() },
    { id: 'palette', icon: <Search />, label: 'Search everything', run: () => openPalette() },
    { id: 'copy', icon: <ClipboardCopy />, label: 'Copy from Claude', run: () => setClaudeTab('copy') },
    { id: 'paste', icon: <ClipboardPaste />, label: 'Paste', run: () => { void pasteFromClipboard(); } },
    { id: 'links', icon: <Link />, label: 'Links in this session', run: () => requestLinks() },
    { id: 'textview', icon: <TextCursor />, label: 'Select text', sub: 'hold a word, like a web page', run: openTextView },
    { id: 'find', icon: <TextSearch />, label: 'Find in output', run: () => setShowSearch(true) },
    { id: 'window', icon: <SquarePlus />, label: 'New window', sub: 'in this session', run: () => createWindow() },
    { id: 'tsettings', icon: <Palette />, label: 'Appearance', sub: 'theme, font and size', run: () => setShowStyleSheet(true) },
    { id: 'shortcuts', icon: <Keyboard />, label: 'Keyboard shortcuts', sub: 'for a phone with keys', run: () => openShortcuts() },
  ];

  // A session that ended drops the soft keyboard: there is nothing to type into.
  useEffect(() => {
    if (isEnded) terminalRef.current?.blur();
  }, [isEnded]);

  // ------------------------------------------------------------------ render
  const r = readout(connectionState, rttMs);
  let line2: ReactNode;
  if (confirmation) {
    line2 = (
      <HeaderFlash action={(
        <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={confirmation.stop} title="Press Esc in the session to interrupt what was just approved">
          Stop
        </button>
      )}>
        {confirmation.text}
      </HeaderFlash>
    );
  } else if (flash) {
    line2 = <HeaderFlash key={flash.id}>{flash.text}</HeaderFlash>;
  } else if (uploading) {
    line2 = <HeaderFlash>Uploading…</HeaderFlash>;
  } else if (isEnded) {
    line2 = <span className="st k-exited">Ended</span>;
  } else if (!online) {
    line2 = <span className="st k-disconnected">{r.text === 'offline' ? 'Offline' : 'Reconnecting'}</span>;
  } else if (liveAttached && k) {
    line2 = (
      <>
        <span className={`st k-${k}`}>{stateWord(liveAttached, k)}</span>
        <span className="sep" aria-hidden>·</span>
        <span className={`shrink-0 font-mono text-micro tnum ${r.kind === 'slow' ? 'text-fg-1' : ''}`}>{r.text}</span>
      </>
    );
  }

  const answerShown = !!(prompt && watching && !confirmation);
  const waitingElsewhere = waitingSessions(sessions).filter((s) => s.id !== attachedSession?.id).length;
  const dockItems: DockItem[] = [
    { id: 'sessions', icon: <Rows3 />, label: 'Sessions', badge: waitingElsewhere, onPress: () => setShowSwitcher(true) },
    { id: 'keys', icon: <Keyboard />, label: 'Keys', on: keysShown, onPress: toggleKeys, aria: keysShown ? 'Hide the keys' : 'Show the keys' },
    {
      id: 'dictate',
      icon: canDictate ? <Mic /> : <MessageSquare />,
      label: canDictate ? (voice.isListening ? 'Listening' : 'Dictate') : 'Message',
      // One accent per screen: while the answer bar shows, its first chip is it.
      // The command line's Send takes the accent once text is in it.
      primary: !answerShown && !isEnded && !lineShown,
      on: voice.isListening,
      live: voice.isListening,
      aria: voice.isListening ? 'Stop dictation' : undefined,
      onPress: () => (canDictate ? voice.toggle() : openComposer({ listen: false })),
    },
    { id: 'snippets', icon: <Braces />, label: 'Snippets', onPress: () => setShowSnippets(true) },
    { id: 'more', icon: <Ellipsis />, label: 'More', onPress: () => setShowMore(true) },
  ];
  const term = terminalRef.current;

  return (
    <div className="flex flex-col h-full min-w-0 bg-bg-0">
      <PhoneHeader
        ref={headerTitleRef}
        onBack={detachSession}
        glyph={liveAttached ? <SessionIcon session={liveAttached} size={18} /> : undefined}
        name={title}
        line2={line2}
        onTitle={() => { if (!swipedRef.current) setShowSwitcher(true); }}
        titleLabel={attachedSession ? `Switch session. ${title}` : 'Switch session'}
        titleKey={attachedSession?.id}
        slide={titleSlide}
        sessions={sessions}
        currentId={attachedSession?.id ?? null}
        onJumpWaiting={(s) => switchTo(s.id)}
        onSearch={() => openPalette()}
        onAttach={filesDisabled || !liveAttached || isEnded ? undefined : () => fileInputRef.current?.click()}
        attachBusy={uploading}
      />

      {/* Upload (More, Alt+U) */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* Find-in-scrollback bar */}
      {showSearch && (
        <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 bg-bg-1 border-b border-line">
          <input
            value={searchQuery}
            onChange={(e) => runSearch(e.target.value, true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(searchQuery, false);
              if (e.key === 'Escape') closeSearch();
            }}
            placeholder="Find in output…"
            aria-label="Find in output"
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            className="flex-1 min-w-0 h-9 px-3 bg-bg-term border border-line-2 rounded-[6px] text-body text-fg-1 placeholder:text-fg-3 outline-none focus:border-accent/45"
          />
          <span className="shrink-0 w-12 text-center text-micro text-fg-3 tnum">
            {searchCount ? `${searchCount.current}/${searchCount.total}` : searchQuery ? '0' : ''}
          </span>
          <IconButton label="Previous match" onPointerDown={(e) => e.preventDefault()} onClick={() => searchAddonRef.current?.findPrevious(searchQuery, SEARCH_DECOR)}>
            <ChevronUp className="w-4 h-4" strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Next match" onPointerDown={(e) => e.preventDefault()} onClick={() => searchAddonRef.current?.findNext(searchQuery, SEARCH_DECOR)}>
            <ChevronDown className="w-4 h-4" strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Close find" onPointerDown={(e) => e.preventDefault()} onClick={closeSearch}>
            <X className="w-4 h-4" strokeWidth={1.75} />
          </IconButton>
        </div>
      )}

      {/* Window tabs — only show when session has multiple windows */}
      {windows.length > 1 && (
        <div className="shrink-0 flex items-center px-2 py-1 bg-bg-1 border-b border-line gap-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {windows.map((w) => (
            <WindowTab key={w.index} w={w} windowCount={windows.length} />
          ))}
          <IconButton label="New window" onClick={() => createWindow()}>
            <Plus className="w-4 h-4" strokeWidth={1.75} />
          </IconButton>
        </div>
      )}

      {/* Terminal — absolute positioning gives xterm.js real pixel dimensions */}
      <div
        className="flex-1 min-h-0 relative overflow-hidden pl-term-surround"
        onClick={() => {
          // Ended: nothing to type into, so don't raise the keyboard.
          if (useAppStore.getState().endedSession) return;
          // A tap on the prompt row: the command line takes the keyboard.
          // Any other tap leaves focus with xterm (inputmode none), which puts
          // the keyboard away on purpose, like tapping away in a chat app.
          if (lineShownRef.current && performance.now() - cmdTapAtRef.current < 500) {
            cmdTapAtRef.current = 0;
            cmdRef.current?.focus();
            return;
          }
          const rd = readerRef.current;
          if (rd?.active) {
            // A tap on the text page with nothing selected closes it; with a
            // selection the OS collapses it and selectionchange closes it.
            if (!rd.hasSelection()) rd.dispose();
            return;
          }
          terminalRef.current?.focus();
        }}
      >
        <div
          ref={termRef}
          className={`absolute inset-0 overflow-hidden transition-opacity duration-200 ${ended ? 'opacity-50' : ''}`}
        />
        {/* The session just left, held until this one paints. */}
        <div ref={ghostRef} className="pl-term-ghost" aria-hidden inert />
        {ended && <ExitedTombstone ended={ended} onRestart={restartEnded} onDismiss={dismissEnded} />}
        {/* Input-debug overlay — raw events, newest at the bottom */}
        {inputDebug && (
          <div className="absolute left-2 top-2 z-40 pointer-events-none rounded-[10px] bg-black/80 px-2.5 py-2 font-mono text-[11px] leading-4 text-accent-hi max-w-[75vw] break-words">
            {debugLog.length === 0
              ? <div className="text-fg-3">input debug — waiting for events…</div>
              : debugLog.map((l, i) => <div key={i}>{l.msg}{l.n > 1 ? ` ×${l.n}` : ''}</div>)}
          </div>
        )}
        {/* Jump to the newest output — escapes tmux copy-mode/scrollback back
            to the prompt. Typing does the same (server-side). */}
        {scrolledUp && (
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              jumpToLive();
            }}
            className="pl-latest"
            aria-label="Jump to the newest output"
            title="Jump to the newest output"
          >
            <ArrowDown className="w-4 h-4" strokeWidth={1.75} />
          </button>
        )}
        {/* Paste catcher — the clipboard API refused (plain-http server or a
            webview without the permission UI). Android will still offer Paste
            on a long-press over an editable box, so give it one: the paste
            event is intercepted and typed into the session; nothing is ever
            edited here. Keyboard suppressed so the sheet doesn't jump. */}
        {pasteCatcher && (
          <div
            className="absolute inset-x-3 top-3 z-40 rounded-[10px] bg-bg-2 border border-line-2 shadow-(--e-2-shadow) p-3"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-meta text-fg-2 mb-2">
              This server is plain http, so the clipboard is locked to the page. Hold the box and choose <span className="text-fg-1 font-medium">Paste</span>.
            </div>
            <div
              ref={pasteCatcherRef}
              contentEditable
              suppressContentEditableWarning
              inputMode="none"
              spellCheck={false}
              autoCapitalize="off"
              className="min-h-11 rounded-[6px] bg-bg-term px-3 py-2.5 font-mono text-[13px] text-fg-1 border border-line-2 outline-none focus:border-accent/45"
              onBeforeInput={(e) => e.preventDefault()}
              onPaste={(e) => {
                e.preventDefault();
                const text = e.clipboardData.getData('text');
                setPasteCatcher(false);
                if (text) sendInput(text);
                terminalRef.current?.focus();
              }}
            />
            <div className="flex justify-end mt-2">
              <button type="button" className="pl-btn" onClick={() => { setPasteCatcher(false); terminalRef.current?.focus(); }}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {/* A long link drop: the inline banner, docked over the bottom rows. */}
        <ReconnectBanner docked />
      </div>

      {/* The question on screen and its answers, pinned above the keys. */}
      {answerShown && prompt && (
        <AnswerBar
          name={title}
          question={prompt.question}
          options={answerOptions(prompt)}
          accent={!prompt.multi}
          onAnswer={answer}
          onReply={openReply}
          onOpenQuestion={() => setClaudeTab('answer')}
        />
      )}

      {/* The key row: the keys a soft keyboard lacks, with the shell's
          suggestions for what you are typing. Suggestions alone when the
          keys are put away. */}
      {(keysShown || sugg.items.length > 0) && (
        <KeyRow
          sendInput={sendInput}
          ctrlArmed={ctrlArmed}
          onToggleCtrl={toggleCtrl}
          onOpenSnippets={() => setShowSnippets(true)}
          suggestions={sugg}
          onSuggest={(cmd) => {
            sendInput(cmd.slice(sugg.prefix.length));
            setSugg({ prefix: '', items: [] });
          }}
          keys={keysShown}
          onHide={kbVisible ? hideKeyboard : undefined}
        />
      )}

      {lineShown && attachedSession && !isEnded && (
        <CommandLine
          // A fresh, empty line per session: a half-typed command must never
          // follow a swipe into another session and run there.
          key={attachedSession.id}
          ref={cmdRef}
          onSend={sendLine}
          sendInput={sendInput}
          ctrlArmed={ctrlArmed}
          onCtrlUsed={() => { ctrlArmedRef.current = false; setCtrlArmed(false); }}
          onLive={goLive}
          target={title}
          offline={!online}
        />
      )}

      <Dock items={dockItems} hidden={kbVisible} />

      {/* Composer: write or dictate, review, then send once. */}
      {composer && attachedSession && (
        <Composer
          variant="sheet"
          listen={composer.listen}
          title={composer.redirectKey ? 'Tell Claude what to do instead' : 'Message'}
          target={`to ${title}`}
          context={composer.context}
          hint={composer.redirectKey
            ? 'Send picks "No, explain", then types your words'
            : watching && prompt
              ? `Sent as your answer to ${title}, then Enter`
              : 'Sent as one message, then Enter'}
          onSend={(text) => deliverText(text, true, composer.redirectKey)}
          onInsert={(text) => deliverText(text, false, composer.redirectKey)}
          onClose={() => setComposer(null)}
        />
      )}

      {/* Session switcher */}
      {showSwitcher && (
        <SessionSwitcher
          sessions={sessions}
          currentId={attachedSession?.id ?? null}
          onPick={(id) => switchTo(id)}
          onNew={() => { setShowSwitcher(false); setShowTabPicker(true); }}
          onClose={() => setShowSwitcher(false)}
        />
      )}

      {/* New session from a profile */}
      {showTabPicker && <NewSessionSheet onClose={() => setShowTabPicker(false)} />}

      {/* Harvested links — opens when the server's session.links reply lands */}
      {sessionLinks !== null && <LinkSheet links={sessionLinks} onClose={clearSessionLinks} />}

      {/* Claude: answer the question in full, or copy the last reply */}
      {claudeTab && (
        <ClaudeSheet
          tab={claudeTab}
          onTab={setClaudeTab}
          name={title}
          prompt={watching ? prompt : null}
          waiting={watching && liveAttached ? stateWord(liveAttached, 'waiting') : null}
          onAnswer={answer}
          onReply={openReply}
          reply={claudeReply}
          onRequestReply={requestClaudeReply}
          onClose={closeClaude}
        />
      )}

      {/* Terminal appearance sheet — live theme/font/size changes */}
      {showStyleSheet && <TerminalSettings variant="sheet" onClose={() => setShowStyleSheet(false)} />}
      {showMore && attachedSession && (
        <MoreSheet
          title={attachedSession.name || title}
          sub={attachedSession.profileName && attachedSession.profileName !== attachedSession.name ? attachedSession.profileName : undefined}
          header={(
            <>
              {term && <span>Terminal <b className="font-medium text-fg-2 tnum">{term.cols} x {term.rows}</b></span>}
              <ConnectionReadout server />
            </>
          )}
          items={moreItems}
          onClose={() => setShowMore(false)}
        />
      )}

      {/* Snippet library — insert, run detached, or fan out across servers */}
      {showSnippets && <SnippetSheet onClose={() => setShowSnippets(false)} sendInput={sendInput} />}
    </div>
  );
}
