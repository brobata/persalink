import { useEffect, useRef, useCallback, useState, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { useAppStore } from '../stores/appStore';
import { handleOsc52, copyTextToClipboard } from '../lib/clipboardBridge';
import { hasPendingShare, SHARE_PENDING_OP } from '../lib/shareTarget';
import { useTerminalStyleStore, getTheme, getFontStack } from '../stores/terminalStyleStore';
import { TerminalSettings } from './TerminalSettings';
import { SnippetSheet } from './SnippetSheet';
import { useVoiceInput } from '../lib/voiceInput';
import { saveDims } from '../lib/terminalDims';
import { createSwipeAutoSpacer } from '../lib/swipeAutoSpace';
import { uploadFiles } from '../lib/upload';
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

// Arrow-key joystick (lives on the FAB — the terminal long-press belongs to
// native text selection now): repeat interval by drag distance from the press
// point — hold still to keep the current rate, drag further to shift up.
const JOY_GEARS = [
  { maxDist: 56, intervalMs: 180 },
  { maxDist: 128, intervalMs: 90 },
  { maxDist: Infinity, intervalMs: 45 },
];
const ARROW_SEQ = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' } as const;
const JOY_HOLD_MS = 300;
const JOY_ACTIVATE_PX = 14;

// Android-style selection handle: a teardrop whose TIP sits on the selection
// boundary (bottom-left of the first cell / bottom-right of the last), inside
// a 44px hit box so a thumb can actually grab it. Pointer-captured so a drag
// never scrolls the terminal underneath, and the grab offset is preserved so
// the boundary doesn't jump to the fingertip the moment it's touched — the
// two things the first (20px, offset-above-finger) version got wrong.
function SelHandle({ x, y, side, onDrag, onDragEnd }: {
  x: number;
  y: number;
  side: 'start' | 'end';
  onDrag: (tipClientX: number, tipClientY: number) => void;
  onDragEnd: () => void;
}) {
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const HIT = 44;
  const DOT = 22;
  const TIP_X = side === 'start' ? HIT - 11 : 11; // tip offset inside the hit box
  const TIP_Y = 6;
  return (
    <div
      className="absolute z-30"
      style={{ left: x - TIP_X, top: y - TIP_Y, width: HIT, height: HIT, touchAction: 'none' }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        grab.current = { dx: e.clientX - (r.left + TIP_X), dy: e.clientY - (r.top + TIP_Y) };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!grab.current || e.buttons === 0) return;
        onDrag(e.clientX - grab.current.dx, e.clientY - grab.current.dy);
      }}
      onPointerUp={() => { grab.current = null; onDragEnd(); }}
      onPointerCancel={() => { grab.current = null; onDragEnd(); }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={`absolute rounded-full bg-sky-400 border-2 border-sky-100 shadow-lg ${
          side === 'start' ? 'rounded-tr-none' : 'rounded-tl-none'
        }`}
        style={{ width: DOT, height: DOT, left: side === 'start' ? TIP_X - DOT : TIP_X, top: TIP_Y }}
      />
    </div>
  );
}

function SelBarButton({ onClick, children, muted }: {
  onClick: () => void;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-10 px-3.5 text-[13px] font-medium active:bg-zinc-700 whitespace-nowrap ${
        muted ? 'text-zinc-400' : 'text-zinc-100'
      }`}
    >
      {children}
    </button>
  );
}

// Space that doubles as a trackpad: tap = space, hold + slide = arrow keys —
// Termius's "hold Space and slide" alternative cursor control. Trackpad
// semantics (one arrow per step of travel), distinct from the hold-joystick
// on the terminal surface. touch-action none + pointer capture keep the
// slide from scrolling the key bar underneath.
function SpaceTrackpadKey({ sendInput }: { sendInput: (data: string) => void }) {
  const STEP_PX = 14;
  const stateRef = useRef({ active: false, moved: false, lastX: 0, lastY: 0 });
  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        stateRef.current = { active: true, moved: false, lastX: e.clientX, lastY: e.clientY };
      }}
      onPointerMove={(e) => {
        const s = stateRef.current;
        if (!s.active) return;
        const dx = e.clientX - s.lastX;
        const dy = e.clientY - s.lastY;
        if (Math.abs(dx) >= Math.abs(dy)) {
          const steps = Math.trunc(dx / STEP_PX);
          if (steps !== 0) {
            s.lastX += steps * STEP_PX;
            s.lastY = e.clientY;
            s.moved = true;
            sendInput((steps > 0 ? '\x1b[C' : '\x1b[D').repeat(Math.abs(steps)));
          }
        } else {
          const steps = Math.trunc(dy / STEP_PX);
          if (steps !== 0) {
            s.lastY += steps * STEP_PX;
            s.lastX = e.clientX;
            s.moved = true;
            sendInput((steps > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(steps)));
          }
        }
      }}
      onPointerUp={() => {
        const s = stateRef.current;
        if (s.active && !s.moved) sendInput(' ');
        s.active = false;
      }}
      onPointerCancel={() => { stateRef.current.active = false; }}
      className="shrink-0 min-w-[72px] px-4 py-2 text-xs font-mono bg-zinc-800 text-zinc-400 rounded-md active:bg-zinc-600 transition-colors select-none"
      style={{ touchAction: 'none' }}
      title="Space — hold and slide for arrow keys"
    >
      ␣
    </button>
  );
}

function TerminalKeyBar({ sendInput, ctrlArmed, onToggleCtrl, onOpenSnippets }: {
  sendInput: (data: string) => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onOpenSnippets: () => void;
}) {
  return (
    <div
      className="shrink-0 flex gap-1 px-2 py-1.5 bg-zinc-900 border-t border-zinc-800 overflow-x-auto"
      style={{ scrollbarWidth: 'none' }}
    >
      {/* Sticky Ctrl — arm it, then type any letter on the soft keyboard to
          send that Ctrl-combo (soft keyboards have no Ctrl key, and a fixed
          ^X list can never cover them all). Disarms after one use. */}
      <button
        onPointerDown={(e) => { e.preventDefault(); onToggleCtrl(); }}
        className={`shrink-0 min-w-[44px] px-2 py-2 text-xs font-mono rounded-md transition-colors select-none ${
          ctrlArmed ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-200 active:bg-zinc-600'
        }`}
      >
        Ctrl
      </button>
      <SpaceTrackpadKey sendInput={sendInput} />
      {/* Snippet library — saved commands with {{variable}} prompts */}
      <button
        onPointerDown={(e) => { e.preventDefault(); onOpenSnippets(); }}
        className="shrink-0 min-w-[44px] px-2 py-2 text-xs font-mono bg-zinc-800 text-zinc-200 rounded-md active:bg-zinc-600 transition-colors select-none"
        title="Snippets — saved commands"
      >
        {'{}'}
      </button>
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-h-[70vh] bg-zinc-900 border-t border-zinc-700 rounded-t-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-zinc-900 px-4 pt-3 pb-2 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-300">Links on screen</span>
          <button onClick={onClose} className="px-2 py-1 text-zinc-500 text-sm">Close</button>
        </div>
        <div className="px-3 py-2 pb-[max(12px,env(safe-area-inset-bottom))]">
          {links.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-zinc-600">
              No links found in recent output
            </div>
          )}
          {links.map((url, i) => (
            <div key={`${url}-${i}`} className="flex items-center gap-1">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-0 px-3 py-3 text-sm text-sky-400 active:bg-zinc-800 rounded-lg break-all leading-snug"
              >
                {url}
              </a>
              <button
                onClick={() => copy(url, i)}
                className="shrink-0 px-2.5 py-2.5 text-zinc-500 active:text-zinc-200 transition-colors"
                title="Copy link"
              >
                {copiedIdx === i ? (
                  <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// One switcher row. The pencil swaps the row into an inline rename input —
// the only way to rename a session from inside the terminal on mobile
// (desktop panes have double-click; gestures proved undiscoverable).
function SwitcherRow({ s, active, onPick, onClose }: {
  s: SessionInfo;
  active: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const renameSession = useAppStore((st) => st.renameSession);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');

  const commitEdit = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== s.name) renameSession(s.id, trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className={`flex items-center gap-3 px-3 py-2 rounded-lg ${active ? 'bg-zinc-800' : ''}`}>
        <span className="text-base shrink-0">{s.profileIcon || '🖥️'}</span>
        <input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="flex-1 min-w-0 px-2 py-1.5 bg-zinc-900 border border-zinc-600 rounded-lg text-sm text-zinc-100 outline-none"
          autoFocus
        />
      </div>
    );
  }

  return (
    <div className={`flex items-center rounded-lg transition-colors ${active ? 'bg-zinc-800' : 'active:bg-zinc-800/60'}`}>
      <button
        onClick={() => { onPick(s.id); onClose(); }}
        className="flex-1 min-w-0 flex items-center gap-3 px-3 py-3 text-left"
      >
        <span className="text-base shrink-0">{s.profileIcon || '🖥️'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex-1 min-w-0 truncate text-sm text-zinc-100">{s.name || s.profileName || s.id}</span>
            {s.attention === 'working' && <span className="shrink-0 text-[10px] text-sky-300">working…</span>}
            {s.attention === 'waiting' && <span className="shrink-0 text-[10px] font-semibold text-amber-300 bg-amber-500/15 px-1.5 py-0.5 rounded-full">needs you</span>}
            {s.attention === 'error' && <span className="shrink-0 w-2 h-2 rounded-full bg-red-500" />}
            {s.unseen && s.attention !== 'waiting' && s.attention !== 'error' && <span className="shrink-0 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
            {active && <span className="shrink-0 text-[10px] text-zinc-500">current</span>}
          </div>
          {/* Live peek at the pane — see what's happening before switching */}
          {s.preview && (
            <div className="text-[10px] text-zinc-600 font-mono truncate mt-0.5">{s.preview}</div>
          )}
        </div>
      </button>
      <button
        onClick={() => { setEditName(s.name || s.profileName || ''); setEditing(true); }}
        className="shrink-0 px-2.5 py-3 text-zinc-600 active:text-zinc-200 transition-colors"
        title="Rename session"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
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
    <div className="fixed inset-0 z-50" onClick={onClose}>
      {/* Dropdown anchored just under the top bar, where the trigger lives —
          opening a bottom sheet from a top button felt disorienting. */}
      <div
        className="absolute left-2 right-2 max-h-[60vh] bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl overflow-y-auto"
        style={{ top: 'calc(env(safe-area-inset-top) + 2.75rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-zinc-900 px-4 pt-3 pb-2 border-b border-zinc-800 flex items-center justify-between rounded-t-2xl">
          <span className="text-sm font-semibold text-zinc-300">Switch session</span>
          <button onClick={onNew} className="text-xs text-emerald-400 active:text-emerald-300">+ New</button>
        </div>
        <div className="px-2 py-2 space-y-0.5">
          {sessions.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-zinc-600">No live sessions</div>
          )}
          {sessions.map((s) => (
            <SwitcherRow key={s.id} s={s} active={s.id === currentId} onPick={onPick} onClose={onClose} />
          ))}
        </div>
      </div>
    </div>
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

export function TerminalScreen({ sidebarVisible = false }: { sidebarVisible?: boolean }) {
  const {
    attachedSession, sendInput, exitScroll, resize, detachSession, killSession,
    initialScrollback, windows, selectWindow, createWindow, serverUrl, authToken,
    sessions, activeTabId, switchTab, closeTab, showTabPicker, setShowTabPicker, getTabs,
    attachSession, connectionState, requestLinks, sessionLinks, clearSessionLinks,
    snippets,
  } = useAppStore();

  // 'authenticated' is the only fully-usable state; anything else means input
  // won't reach the session, so surface it instead of dropping keystrokes silently.
  const online = connectionState === 'authenticated';
  const connLabel = connectionState === 'reconnecting' ? 'Reconnecting…'
    : connectionState === 'disconnected' ? 'Offline'
    : connectionState === 'connecting' ? 'Connecting…'
    : 'Authenticating…';

  const tabs = useMemo(() => getTabs(), [sessions]);

  const [uploading, setUploading] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  // Terminal appearance bottom sheet (themes/font/size) — mobile finally gets
  // the same styling controls the desktop grid's gear popover has.
  const [showStyleSheet, setShowStyleSheet] = useState(false);
  // Snippet library sheet (opened from the key bar's {} key).
  const [showSnippets, setShowSnippets] = useState(false);
  // Quick-actions dial: one FAB that fans out keyboard / mic / paste /
  // snippets + the first few var-free snippets as one-tap pills. Replaces the
  // separate keyboard + mic buttons that were eating terminal real estate.
  const [fabOpen, setFabOpen] = useState(false);
  const quickSnips = useMemo(
    () => snippets.filter((s) => !/\{\{[a-zA-Z0-9_ -]+\}\}/.test(s.command)).slice(0, 3),
    [snippets],
  );
  // FAB joystick: hold the FAB ~a third of a second, then drag any direction
  // for repeating arrow keys with the same speed gears the on-screen hold
  // used to have. A plain tap still opens the dial; a joystick run suppresses
  // that click on release.
  const fabJoyRef = useRef({
    armed: false, active: false, suppressClick: false,
    startX: 0, startY: 0, lastX: 0, lastY: 0, gear: -1,
    holdTimer: null as ReturnType<typeof setTimeout> | null,
    tickTimer: null as ReturnType<typeof setTimeout> | null,
  });
  const fabJoyStop = useCallback(() => {
    const j = fabJoyRef.current;
    if (j.holdTimer) clearTimeout(j.holdTimer);
    if (j.tickTimer) clearTimeout(j.tickTimer);
    j.holdTimer = null;
    j.tickTimer = null;
    j.armed = false;
    j.active = false;
    j.gear = -1;
  }, []);
  const fabJoyDown = useCallback((e: ReactPointerEvent) => {
    const j = fabJoyRef.current;
    fabJoyStop();
    j.suppressClick = false;
    j.startX = e.clientX; j.startY = e.clientY;
    j.lastX = e.clientX; j.lastY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    j.holdTimer = setTimeout(() => {
      j.holdTimer = null;
      j.armed = true;
      try { navigator.vibrate?.(15); } catch { /* unsupported */ }
    }, JOY_HOLD_MS);
  }, [fabJoyStop]);
  const fabJoyMove = useCallback((e: ReactPointerEvent) => {
    const j = fabJoyRef.current;
    j.lastX = e.clientX; j.lastY = e.clientY;
    if (!j.armed || j.active) return;
    if (Math.hypot(e.clientX - j.startX, e.clientY - j.startY) <= JOY_ACTIVATE_PX) return;
    j.active = true;
    j.suppressClick = true;
    const tick = () => {
      const dx = j.lastX - j.startX;
      const dy = j.lastY - j.startY;
      const dist = Math.hypot(dx, dy);
      const dir = Math.abs(dx) >= Math.abs(dy)
        ? (dx >= 0 ? 'right' : 'left')
        : (dy >= 0 ? 'down' : 'up');
      sendInput(ARROW_SEQ[dir]);
      const gear = JOY_GEARS.findIndex((g) => dist <= g.maxDist);
      if (gear !== j.gear) {
        j.gear = gear;
        try { navigator.vibrate?.(8); } catch { /* unsupported */ }
      }
      j.tickTimer = setTimeout(tick, JOY_GEARS[gear].intervalMs);
    };
    tick();
  }, [sendInput]);
  useEffect(() => () => fabJoyStop(), [fabJoyStop]);
  // Hardware-keyboard detection (Titan etc.): soft IMEs composite text and don't emit
  // keydowns with real codes, so the first trusted one that does means a physical keyboard
  // exists. Deliberately NOT limited to letters and digits: reaching a symbol on the Titan
  // starts with Alt or Sym, and until detection flips, inputmode stays "none" and the IME is
  // out of the pipeline — so the very chord that most needs the IME was the one that could
  // never switch it on, and its symbol was swallowed. Modifiers count as evidence now.
  // Sticky per device — once seen, the soft-keyboard dial item is dead weight and hides.
  const [hwKeyboard, setHwKeyboard] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (userAgentSuggestsHardwareKeyboard()) return true;
    try { return localStorage.getItem('persalink-hw-keyboard') === 'true'; } catch { return false; }
  });
  // Client hints resolve a tick after mount. Deliberately NOT written to localStorage: a model
  // match should stay a live answer, so a wrong pattern here can never be baked into a device
  // permanently the way a real keypress legitimately is.
  useEffect(() => {
    if (hwKeyboard) return;
    let cancelled = false;
    void modelSuggestsHardwareKeyboard().then((isHardware) => {
      if (!cancelled && isHardware) setHwKeyboard(true);
    });
    return () => { cancelled = true; };
  }, [hwKeyboard]);
  useEffect(() => {
    if (hwKeyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isPhysicalKeyEvent(e)) return;
      setHwKeyboard(true);
      try { localStorage.setItem('persalink-hw-keyboard', 'true'); } catch { /* private mode */ }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hwKeyboard]);
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
  const [softKbOn, setSoftKbOn] = useState(false);
  const softKbOnRef = useRef(false);
  const hwKeyboardRef = useRef(hwKeyboard);
  hwKeyboardRef.current = hwKeyboard;
  const resolveInputMode = useCallback((on: boolean): 'text' | 'none' => {
    if (on) return 'text';
    return hwKeyboardRef.current && useTerminalStyleStore.getState().hwImeCompat ? 'text' : 'none';
  }, []);
  const applySoftKb = useCallback((on: boolean) => {
    softKbOnRef.current = on;
    setSoftKbOn(on);
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

  // In-place selection (Termius model): xterm highlights + extracts the text,
  // this state carries the pixel geometry for the two handles and the
  // floating Copy/Paste bar. The imperative engine lives inside the terminal
  // effect and is reached through selApiRef.
  const [selOverlay, setSelOverlay] = useState<null | {
    sx: number; sy: number; ex: number; ey: number;
    startVisible: boolean; endVisible: boolean;
    barX: number; barY: number;
    text: string;
  }>(null);
  const selOverlayRef = useRef(selOverlay);
  selOverlayRef.current = selOverlay;
  const selApiRef = useRef<null | {
    beginAtCursor: () => void;
    dragTip: (which: 'start' | 'end', tipClientX: number, tipClientY: number) => void;
    endDrag: () => void;
    selectAll: () => void;
    clear: () => void;
  }>(null);
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
        sendInput(paths.join(' ') + ' ');
        // The file picker stole focus — hand it straight back with the
        // keyboard up, since the next act is always typing around the path.
        applySoftKb(true);
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
      terminalRef.current?.focus();
    }
  };

  // Handle output events — only write if sessionId matches, otherwise buffer
  // until the matching terminal mounts (covers the attach handshake window).
  const handleOutput = useCallback((e: Event) => {
    const { data, sessionId } = (e as CustomEvent).detail;
    if (terminalRef.current && sessionId === sessionIdRef.current) {
      terminalRef.current.write(data);
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
    term.loadAddon(new WebLinksAddon());
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
      for (const entry of pendingOutputRef.current) {
        if (entry.sessionId === targetId) {
          term.write(entry.data);
        }
      }
      pendingOutputRef.current = [];
    }

    // Touch-selection anchors (see the in-place selection engine below);
    // declared here because the desktop auto-copy hook must ignore them.
    let selAnchor: { a: number; b: number } | null = null;

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
      if (!hasFreshSelection || selAnchor) return; // touch selections copy via their bar
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
    });

    // ------------------------------------------------------------------
    // In-place selection (Termius model). xterm's own selection service does
    // the highlight and the text (it joins soft-wrapped rows, so a wrapped
    // path or URL copies unbroken); this layer owns the touch UX:
    //   hold ~400ms, finger still → word under the finger selected (haptic)
    //   keep holding + drag       → extend from that word, edge auto-scroll
    //   release                   → two handles + Copy/Paste/All bar stay up
    //   drag a handle             → move that end, cell-snapped, edge scroll
    //   drag on the text          → scroll; handles ride with their rows
    //   tap anywhere              → dismiss
    // No OS text selection is involved (xterm is a canvas), and no
    // transparent DOM mirror either — that approach fought the canvas over
    // alignment, froze under streaming output, and put the caret/Paste
    // bubble where a word selection was wanted. Selection state = two linear
    // cell indices (row * cols + col) so a crossover swaps ends via min/max.
    const WORD_CHAR = /[\p{L}\p{N}_\-./~:@#$%+=?&]/u;
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const screenEl = () => container.querySelector('.xterm-screen') as HTMLElement | null;
    let selDragEnd = false; // the finger that started the hold is extending
    let autoScrollTimer: ReturnType<typeof setInterval> | null = null;
    let autoScrollDir = 0;
    let lastDrag: { which: 'start' | 'end'; x: number; y: number; mode: 'tip' | 'finger' } | null = null;

    const cellGeom = () => {
      const el = screenEl();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { r, cellW: r.width / term.cols, cellH: r.height / term.rows };
    };
    // Clamped to the grid: a finger above/below the screen maps to the first/
    // last visible row, which is exactly what edge auto-scroll wants.
    const cellFromPoint = (clientX: number, clientY: number) => {
      const g = cellGeom();
      if (!g) return null;
      const col = Math.min(term.cols - 1, Math.max(0, Math.floor((clientX - g.r.left) / g.cellW)));
      const vrow = Math.min(term.rows - 1, Math.max(0, Math.floor((clientY - g.r.top) / g.cellH)));
      return { col, row: vrow + term.buffer.active.viewportY };
    };

    const publishOverlay = () => {
      const g = cellGeom();
      const pos = term.getSelectionPosition();
      if (!g || !pos || !selAnchor) {
        setSelOverlay(null);
        return;
      }
      const host = container.getBoundingClientRect();
      const vp = term.buffer.active.viewportY;
      const toPx = (col: number, row: number) => ({
        x: g.r.left - host.left + col * g.cellW,
        y: g.r.top - host.top + (row - vp) * g.cellH,
      });
      // pos.end.x is exclusive — the end handle's tip sits on that boundary.
      const sPx = toPx(pos.start.x, pos.start.y);
      const ePx = toPx(pos.end.x, pos.end.y);
      const inView = (row: number) => row >= vp && row < vp + term.rows;
      // Bar hugs the visible part of the selection: above its first visible
      // row when there's room, otherwise below its last visible row.
      const firstVis = Math.max(pos.start.y, vp);
      const lastVis = Math.min(pos.end.y, vp + term.rows - 1);
      const topY = toPx(0, firstVis).y;
      const botY = toPx(0, lastVis).y + g.cellH;
      // Below the selection the handles hang ~44px under the last row — the
      // bar must clear them or it covers the end handle.
      const barY = topY > 60 ? topY - 52 : botY + 48;
      const midX = (Math.max(sPx.x, 0) + Math.min(ePx.x, host.width)) / 2;
      const barX = Math.min(Math.max(midX, 110), Math.max(110, host.width - 110));
      setSelOverlay({
        sx: sPx.x, sy: sPx.y + g.cellH, ex: ePx.x, ey: ePx.y + g.cellH,
        startVisible: inView(pos.start.y), endVisible: inView(pos.end.y),
        barX, barY,
        text: term.getSelection(),
      });
    };

    const applyLinear = () => {
      if (!selAnchor) return;
      const lo = Math.min(selAnchor.a, selAnchor.b);
      const hi = Math.max(selAnchor.a, selAnchor.b);
      term.select(lo % term.cols, Math.floor(lo / term.cols), hi - lo + 1);
      publishOverlay();
    };

    // Word under a cell (shell-ish word chars: paths, URLs, flags, hashes);
    // a blank cell selects just itself so a drag can still grow from there.
    const wordRangeAt = (row: number, col: number) => {
      const text = term.buffer.active.getLine(row)?.translateToString(false) ?? '';
      let s0 = col;
      let e0 = col;
      if (WORD_CHAR.test(text[col] ?? '')) {
        while (s0 > 0 && WORD_CHAR.test(text[s0 - 1])) s0--;
        while (e0 < text.length - 1 && WORD_CHAR.test(text[e0 + 1])) e0++;
      }
      return { s: s0, e: e0 };
    };
    const enterSelection = (row: number, s0: number, e0: number) => {
      selAnchor = { a: row * term.cols + s0, b: row * term.cols + e0 };
      applyLinear();
      // Reading mode: drop the soft keyboard so handles and bar aren't buried
      // under Gboard (and its clipboard suggestion strip).
      term.blur();
      try { navigator.vibrate?.(15); } catch { /* unsupported */ }
    };
    const beginSelectionAt = (clientX: number, clientY: number): boolean => {
      const cell = cellFromPoint(clientX, clientY);
      if (!cell) return false;
      const { s: s0, e: e0 } = wordRangeAt(cell.row, cell.col);
      enterSelection(cell.row, s0, e0);
      return true;
    };
    // Toolbar entry (no long-press needed): the cursor's line, trimmed.
    const beginAtCursor = () => {
      const buf = term.buffer.active;
      const row = buf.baseY + buf.cursorY;
      const text = buf.getLine(row)?.translateToString(true) ?? '';
      const first = text.search(/\S/);
      if (first < 0) enterSelection(row, 0, 0);
      else enterSelection(row, first, text.length - 1);
    };

    const setEnd = (which: 'start' | 'end', cell: { col: number; row: number }) => {
      if (!selAnchor) return;
      const idx = cell.row * term.cols + cell.col;
      // 'start' drives the lower linear index, 'end' the higher; a crossover
      // swaps roles naturally through the min/max in applyLinear.
      if (which === 'start') {
        if (selAnchor.a <= selAnchor.b) selAnchor.a = idx;
        else selAnchor.b = idx;
      } else {
        if (selAnchor.b >= selAnchor.a) selAnchor.b = idx;
        else selAnchor.a = idx;
      }
      applyLinear();
    };
    // A handle reports its TIP (the cell boundary); the cell it means is half
    // a cell inward and half a cell up from there. A bare finger is the cell.
    const resolveDrag = (d: NonNullable<typeof lastDrag>) => {
      const g = cellGeom();
      if (!g) return null;
      if (d.mode === 'finger') return cellFromPoint(d.x, d.y);
      const dx = d.which === 'start' ? g.cellW / 2 : -g.cellW / 2;
      return cellFromPoint(d.x + dx, d.y - g.cellH / 2);
    };
    // Edge auto-scroll while dragging near the top/bottom of the grid. Normal
    // buffer only — an alt-screen app (Claude Code, vim) owns its scrollback
    // and xterm can't move it. Speed scales with how far past the edge.
    const EDGE_PX = 32;
    const stopAutoScroll = () => {
      if (autoScrollTimer) clearInterval(autoScrollTimer);
      autoScrollTimer = null;
      autoScrollDir = 0;
    };
    const updateAutoScroll = (clientY: number) => {
      const g = cellGeom();
      let dir = 0;
      if (g && term.buffer.active.type === 'normal') {
        if (clientY < g.r.top + EDGE_PX) dir = -1;
        else if (clientY > g.r.bottom - EDGE_PX) dir = 1;
      }
      if (dir === autoScrollDir) return;
      stopAutoScroll();
      autoScrollDir = dir;
      if (dir === 0) return;
      autoScrollTimer = setInterval(() => {
        const gg = cellGeom();
        if (!gg || !lastDrag) return;
        const past = dir < 0 ? gg.r.top + EDGE_PX - lastDrag.y : lastDrag.y - (gg.r.bottom - EDGE_PX);
        const step = past > EDGE_PX * 2 ? 3 : 1;
        term.scrollLines(dir * step);
        const buf = term.buffer.active;
        setScrolledUp(buf.viewportY < buf.baseY);
        const cell = resolveDrag(lastDrag);
        if (cell) setEnd(lastDrag.which, cell);
      }, 60);
    };
    const drag = (which: 'start' | 'end', x: number, y: number, mode: 'tip' | 'finger') => {
      lastDrag = { which, x, y, mode };
      const cell = resolveDrag(lastDrag);
      if (cell) setEnd(which, cell);
      updateAutoScroll(y);
    };
    const endDrag = () => {
      stopAutoScroll();
      lastDrag = null;
      publishOverlay();
    };
    const clearSelection = () => {
      stopAutoScroll();
      lastDrag = null;
      selDragEnd = false;
      if (!selAnchor) return;
      selAnchor = null;
      term.clearSelection();
      setSelOverlay(null);
    };
    const selectAllBuffer = () => {
      const buf = term.buffer.active;
      selAnchor = { a: 0, b: buf.length * term.cols - 1 };
      applyLinear();
    };
    selApiRef.current = {
      beginAtCursor,
      dragTip: (which, x, y) => drag(which, x, y, 'tip'),
      endDrag,
      selectAll: selectAllBuffer,
      clear: clearSelection,
    };
    // Normal-buffer scrolls move the viewport under the selection — handles
    // and bar track their rows instead of floating loose.
    const selScrollDisp = term.onScroll(() => {
      if (selAnchor) publishOverlay();
    });
    // A long-press on the canvas fires contextmenu on Android; nothing useful
    // lives there and it would steal the gesture from our hold timer.
    const onContextMenu = (e: Event) => { if (coarsePointer) e.preventDefault(); };
    container.addEventListener('contextmenu', onContextMenu);

    // ------------------------------------------------------------------
    // Gesture engine (Termius-style spec). One meaning per gesture, no modes:
    //   plain drag                 → scroll (with momentum fling)
    //   two-finger pinch           → font size (live, persisted)
    //   double-tap                 → Tab (completion; toggleable in settings)
    //   hold (still) then release  → select word, handles + Copy/Paste bar
    //   hold (still) then drag     → select word and extend while dragging
    // The arrow-key joystick that used to live on long-press moved to a
    // hold-and-drag on the quick-actions FAB.
    const TAP_MAX_MS = 250;
    const LONG_PRESS_MS = 400;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let touchStartedWithSel = false;
    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
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
      cancelMomentum();
      cancelKbDismiss(); // a second tap (double-tap Tab) keeps the keyboard up
      cancelLongPress();
      if (e.touches.length >= 2) {
        // Second finger down → pinch. Kill every single-finger gesture state.
        tapCandidate = false;
        selDragEnd = false;
        stopAutoScroll();
        pinching = true;
        pinchStartDist = touchDist(e);
        pinchStartSize = useTerminalStyleStore.getState().fontSize;
        return;
      }
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
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
      touchStartedWithSel = !!selAnchor;
      // Hold still → selection. The timer is cancelled by movement past the
      // tap slop (a scroll), a second finger, or lift.
      const sx = touchStartX;
      const sy = touchStartY;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (!tapCandidate) return;
        tapCandidate = false;
        if (beginSelectionAt(sx, sy)) selDragEnd = true;
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
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

      // The hold that started a selection is still down: it extends the end.
      if (selDragEnd) {
        drag('end', t.clientX, y, 'finger');
        return;
      }
      if (tapCandidate
        && Math.hypot(t.clientX - touchStartX, y - touchStartY) > TAP_SLOP_PX) {
        tapCandidate = false;
        cancelLongPress();
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
      // Hold-and-drag finished: leave handles + bar up, no fling.
      if (selDragEnd) {
        selDragEnd = false;
        endDrag();
        velocity = 0;
        return;
      }
      // Double-tap → Tab. Two quick, still taps close together.
      const now = performance.now();
      if (tapCandidate && now - touchStartTime < TAP_MAX_MS) {
        // A tap while a selection is up dismisses it — and nothing else.
        if (touchStartedWithSel) {
          clearSelection();
          velocity = 0;
          return;
        }
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
          if (!softKbOnRef.current) applySoftKb(true);
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
        clearSelection(); // handles would point at reflowed content
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
      stopAutoScroll();
      selScrollDisp.dispose();
      selApiRef.current = null;
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

        {/* Connection health — only shown when not fully connected. */}
        {!online && (
          <span className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
            connectionState === 'disconnected' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-300'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connectionState === 'disconnected' ? 'bg-red-500' : 'bg-amber-400 animate-pulse'}`} />
            {connLabel}
          </span>
        )}

        {/* Upload */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,.pdf,.txt,.log,.json,.csv,.zip,.tar,.gz"
          onChange={handleFileUpload}
          className="hidden"
        />
        <button
          onPointerDown={(e) => { e.preventDefault(); setShowSearch(true); }}
          className={`shrink-0 px-2 py-2 transition-colors ${showSearch ? 'text-zinc-200' : 'text-zinc-500 active:text-zinc-300'}`}
          title="Find in output"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="M21 21l-4.3-4.3" />
          </svg>
        </button>
        <button
          onPointerDown={(e) => { e.preventDefault(); setShowStyleSheet(true); }}
          className="shrink-0 px-2 py-2 text-zinc-500 active:text-zinc-300 transition-colors"
          title="Terminal appearance — theme, font, size"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 110-18 9 8 0 019 8 4.5 4.5 0 01-4.5 4.5h-1.6a1.9 1.9 0 00-1.4 3.2c.3.3.5.7.5 1.1a1.2 1.2 0 01-1 1.2z" />
            <circle cx="7.5" cy="11.5" r=".8" fill="currentColor" />
            <circle cx="11" cy="7.5" r=".8" fill="currentColor" />
            <circle cx="15.5" cy="9" r=".8" fill="currentColor" />
          </svg>
        </button>
        <button
          onPointerDown={(e) => { e.preventDefault(); requestLinks(); }}
          className="shrink-0 px-2 py-2 text-zinc-500 active:text-zinc-300 transition-colors"
          title="Links on screen — wrapped URLs rejoined"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 010-5.656l3-3a4 4 0 015.656 5.656l-1.5 1.5" />
          </svg>
        </button>
        <button
          onPointerDown={(e) => { e.preventDefault(); pasteFromClipboard(); }}
          className="shrink-0 px-2 py-2 text-zinc-500 active:text-zinc-300 transition-colors"
          title="Paste from clipboard"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
        </button>
        <button
          onPointerDown={(e) => { e.preventDefault(); selApiRef.current?.beginAtCursor(); }}
          className="shrink-0 px-2 py-2 text-zinc-500 active:text-zinc-300 transition-colors"
          title="Select text (or hold a word on the terminal)"
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
          title="Terminal keys bar (arrows, Esc, Tab, Ctrl)"
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

      {/* Find-in-scrollback bar */}
      {showSearch && (
        <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 bg-zinc-900 border-b border-zinc-800">
          <input
            value={searchQuery}
            onChange={(e) => runSearch(e.target.value, true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(searchQuery, false);
              if (e.key === 'Escape') closeSearch();
            }}
            placeholder="Find in output…"
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            className="flex-1 min-w-0 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
          />
          <span className="shrink-0 text-[10px] text-zinc-500 w-12 text-center">
            {searchCount ? `${searchCount.current}/${searchCount.total}` : searchQuery ? '0' : ''}
          </span>
          <button
            onPointerDown={(e) => { e.preventDefault(); searchAddonRef.current?.findPrevious(searchQuery, SEARCH_DECOR); }}
            className="shrink-0 px-2 py-1.5 text-zinc-400 active:text-zinc-100"
            title="Previous match"
          >
            ↑
          </button>
          <button
            onPointerDown={(e) => { e.preventDefault(); searchAddonRef.current?.findNext(searchQuery, SEARCH_DECOR); }}
            className="shrink-0 px-2 py-1.5 text-zinc-400 active:text-zinc-100"
            title="Next match"
          >
            ↓
          </button>
          <button
            onPointerDown={(e) => { e.preventDefault(); closeSearch(); }}
            className="shrink-0 px-2 py-1.5 text-zinc-500 active:text-zinc-300"
            title="Close search"
          >
            &times;
          </button>
        </div>
      )}

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
      {/* No focus while a selection is up: the synthesized click after a
          hold-release would raise the keyboard over the handles and bar. */}
      <div className="flex-1 min-h-0 relative" onClick={() => { if (!selOverlayRef.current) terminalRef.current?.focus(); }}>
        <div ref={termRef} className="absolute inset-0 overflow-hidden" />
        {/* Input-debug overlay — raw events, newest at the bottom */}
        {inputDebug && (
          <div className="absolute left-2 top-2 z-40 pointer-events-none rounded-lg bg-black/80 px-2.5 py-2 font-mono text-[10px] leading-4 text-emerald-300 max-w-[75vw] break-words">
            {debugLog.length === 0
              ? <div className="text-zinc-500">input debug — waiting for events…</div>
              : debugLog.map((l, i) => <div key={i}>{l.msg}{l.n > 1 ? ` ×${l.n}` : ''}</div>)}
          </div>
        )}
        {/* Jump to live — escapes tmux copy-mode/scrollback back to the prompt.
            Discoverable counterpart to typing (which auto-exits server-side). */}
        {scrolledUp && (
          <button
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              jumpToLive();
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
        {/* In-place selection: two draggable handles + floating Copy/Paste bar.
            xterm draws the highlight; these anchor to its buffer coordinates. */}
        {selOverlay && (
          <>
            {selOverlay.startVisible && (
              <SelHandle
                x={selOverlay.sx}
                y={selOverlay.sy}
                side="start"
                onDrag={(cx, cy) => selApiRef.current?.dragTip('start', cx, cy)}
                onDragEnd={() => selApiRef.current?.endDrag()}
              />
            )}
            {selOverlay.endVisible && (
              <SelHandle
                x={selOverlay.ex}
                y={selOverlay.ey}
                side="end"
                onDrag={(cx, cy) => selApiRef.current?.dragTip('end', cx, cy)}
                onDragEnd={() => selApiRef.current?.endDrag()}
              />
            )}
            <div
              className="absolute z-30 flex items-center overflow-hidden rounded-xl bg-zinc-800/95 border border-zinc-600 shadow-xl divide-x divide-zinc-700"
              style={{ left: selOverlay.barX, top: Math.max(4, selOverlay.barY), transform: 'translateX(-50%)' }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <SelBarButton
                onClick={() => {
                  const text = selOverlay.text;
                  // Inside the tap's user gesture — the only time Android lets
                  // a page write the clipboard. Success is silent (user call).
                  void copyTextToClipboard(text).then((ok) => {
                    if (!ok) useAppStore.getState().pushNotification('error', 'Copy blocked by browser', 'copy');
                  });
                  try { navigator.vibrate?.(10); } catch { /* unsupported */ }
                  selApiRef.current?.clear();
                }}
              >
                Copy
              </SelBarButton>
              <SelBarButton onClick={() => { selApiRef.current?.clear(); void pasteFromClipboard(); }}>
                Paste
              </SelBarButton>
              <SelBarButton muted onClick={() => selApiRef.current?.selectAll()}>
                All
              </SelBarButton>
              <SelBarButton muted onClick={() => selApiRef.current?.clear()}>
                ✕
              </SelBarButton>
            </div>
          </>
        )}
        {/* Paste catcher — the clipboard API refused (plain-http server or a
            webview without the permission UI). Android will still offer Paste
            on a long-press over an editable box, so give it one: the paste
            event is intercepted and typed into the session; nothing is ever
            edited here. Keyboard suppressed so the sheet doesn't jump. */}
        {pasteCatcher && (
          <div
            className="absolute inset-x-3 z-40 rounded-xl bg-zinc-800 border border-sky-500/60 shadow-2xl p-3"
            style={{ top: 12 }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[11px] leading-snug text-zinc-400 mb-2">
              This server is plain http, so the clipboard is locked to the page. Hold the box and choose <span className="text-zinc-200 font-medium">Paste</span>.
            </div>
            <div
              ref={pasteCatcherRef}
              contentEditable
              suppressContentEditableWarning
              inputMode="none"
              spellCheck={false}
              autoCapitalize="off"
              className="min-h-11 rounded-lg bg-zinc-950 px-3 py-2.5 font-mono text-sm text-zinc-100 border border-zinc-700 outline-none focus:border-sky-500"
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
              <button
                onClick={() => { setPasteCatcher(false); terminalRef.current?.focus(); }}
                className="h-9 px-3.5 text-[13px] text-zinc-300 rounded-lg bg-zinc-700 active:bg-zinc-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {/* Quick-actions dial — ONE floating button instead of keyboard + mic
            side by side. Tap fans out keyboard / mic / paste / snippets plus
            one-tap pills for the first few var-free snippets. While dictation
            is live the collapsed FAB becomes the pulsing red mic (tap = stop),
            same single-tap stop as the old dedicated button. Every control
            preventDefaults pointer/mouse down so the terminal keeps focus
            (the focus-steal that once killed desktop Ctrl+C). */}
        {fabOpen && (
          <div className="fixed inset-0 z-10" onClick={() => setFabOpen(false)} />
        )}
        {fabOpen && (
          <div
            className="absolute right-3 z-20 flex flex-col items-end gap-2"
            style={{ bottom: 'calc(max(12px, env(safe-area-inset-bottom)) + 3.5rem)' }}
          >
            {quickSnips.map((s, i) => (
              <button
                key={s.id}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => { sendInput(s.command); setFabOpen(false); }}
                className="pl-fab-item max-w-[70vw] truncate px-3 py-2 rounded-full bg-zinc-800/95 border border-zinc-700 text-zinc-200 text-xs font-mono shadow-lg active:bg-zinc-700"
                style={{ animationDelay: `${100 + (quickSnips.length - 1 - i) * 30}ms` }}
                title={s.command}
              >
                {s.name || s.command}
              </button>
            ))}
            <div className="pl-fab-item flex items-center gap-2" style={{ animationDelay: '75ms' }}>
              <span className="px-2 py-1 rounded-md bg-zinc-900/90 text-[11px] text-zinc-400 shadow">Snippets</span>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => { setShowSnippets(true); setFabOpen(false); }}
                className="w-10 h-10 rounded-full shadow-lg flex items-center justify-center bg-zinc-800/95 text-zinc-300 active:bg-zinc-700 font-mono text-sm"
                aria-label="Snippet library"
              >
                {'{}'}
              </button>
            </div>
            <div className="pl-fab-item flex items-center gap-2" style={{ animationDelay: '50ms' }}>
              <span className="px-2 py-1 rounded-md bg-zinc-900/90 text-[11px] text-zinc-400 shadow">Paste</span>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => { void pasteFromClipboard(); setFabOpen(false); }}
                className="w-10 h-10 rounded-full shadow-lg flex items-center justify-center bg-zinc-800/95 text-zinc-300 active:bg-zinc-700"
                aria-label="Paste from clipboard"
              >
                <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </button>
            </div>
            {voice.isSupported && (
              <div className="pl-fab-item flex items-center gap-2" style={{ animationDelay: '25ms' }}>
                <span className="px-2 py-1 rounded-md bg-zinc-900/90 text-[11px] text-zinc-400 shadow">Dictate</span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => { voice.toggle(); setFabOpen(false); }}
                  className="w-10 h-10 rounded-full shadow-lg flex items-center justify-center bg-zinc-800/95 text-zinc-300 active:bg-zinc-700"
                  aria-label="Start dictation"
                >
                  <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
                  </svg>
                </button>
              </div>
            )}
            {/* Hidden on hardware-keyboard devices (Titan): Android suppresses
                the soft keyboard there, so the toggle visibly does nothing. */}
            {!sidebarVisible && !hwKeyboard && (
              <div className="pl-fab-item flex items-center gap-2">
                <span className="px-2 py-1 rounded-md bg-zinc-900/90 text-[11px] text-zinc-400 shadow">Soft keyboard</span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => { applySoftKb(!softKbOn); setFabOpen(false); }}
                  className={`w-10 h-10 rounded-full shadow-lg flex items-center justify-center ${
                    softKbOn ? 'bg-emerald-600 text-white' : 'bg-zinc-800/95 text-zinc-300 active:bg-zinc-700'
                  }`}
                  aria-label={softKbOn ? 'Hide soft keyboard' : 'Show soft keyboard'}
                >
                  <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <rect x="2" y="6" width="20" height="12" rx="2" />
                    <path strokeLinecap="round" d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        )}
        <button
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => { e.preventDefault(); fabJoyDown(e); }}
          onPointerMove={fabJoyMove}
          onPointerUp={fabJoyStop}
          onPointerCancel={fabJoyStop}
          onClick={() => {
            if (fabJoyRef.current.suppressClick) { fabJoyRef.current.suppressClick = false; return; }
            if (!fabOpen && voice.isListening) voice.toggle(); // red mic = tap to stop
            else setFabOpen((v) => !v);
          }}
          className={`absolute right-3 z-20 w-11 h-11 rounded-full shadow-lg flex items-center justify-center transition-colors ${
            voice.isListening && !fabOpen
              ? 'bg-red-500 text-white animate-pulse'
              : softKbOn && !fabOpen && !hwKeyboard
                ? 'bg-emerald-600 text-white'
                : 'bg-zinc-800/90 text-zinc-300 active:bg-zinc-700'
          }`}
          style={{ bottom: 'max(12px, env(safe-area-inset-bottom))', touchAction: 'none' }}
          title={voice.isListening && !fabOpen ? 'Stop dictation' : fabOpen ? 'Close' : 'Quick actions (hold + drag = arrows)'}
          aria-label={voice.isListening && !fabOpen ? 'Stop dictation' : fabOpen ? 'Close quick actions' : 'Quick actions'}
        >
          {voice.isListening && !fabOpen ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
            </svg>
          ) : (
            <svg
              className={`w-5 h-5 transition-transform duration-150 ${fabOpen ? 'rotate-45' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
          )}
        </button>
      </div>

      {/* Suggestion bar — tap a chip to complete the current command */}
      {!sidebarVisible && sugg.items.length > 0 && (
        <div className="shrink-0 flex gap-1.5 px-2 py-1.5 bg-zinc-900/90 border-t border-zinc-800 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {sugg.items.map((cmd) => (
            <button
              key={cmd}
              onPointerDown={(e) => {
                e.preventDefault();
                sendInput(cmd.slice(sugg.prefix.length));
                setSugg({ prefix: '', items: [] });
              }}
              className="shrink-0 max-w-[75vw] truncate px-3 py-1.5 text-xs font-mono bg-zinc-800 text-zinc-300 rounded-full active:bg-zinc-600 select-none"
            >
              <span className="text-zinc-500">{sugg.prefix}</span>
              {cmd.slice(sugg.prefix.length)}
            </button>
          ))}
        </div>
      )}

      {/* Soft-keyboard helper bar — mobile only, toggled from top bar */}
      {!sidebarVisible && showKeyBar && (
        <TerminalKeyBar sendInput={sendInput} ctrlArmed={ctrlArmed} onToggleCtrl={toggleCtrl} onOpenSnippets={() => setShowSnippets(true)} />
      )}

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

      {/* Harvested links — opens when the server's session.links reply lands */}
      {sessionLinks !== null && <LinkSheet links={sessionLinks} onClose={clearSessionLinks} />}

      {/* Terminal appearance sheet — live theme/font/size changes */}
      {showStyleSheet && <TerminalSettings variant="sheet" onClose={() => setShowStyleSheet(false)} />}

      {/* Snippet library — insert, run detached, or fan out across servers */}
      {showSnippets && <SnippetSheet onClose={() => setShowSnippets(false)} sendInput={sendInput} />}

    </div>
  );
}
