/**
 * @file CommandLine
 * @description The one input row for touch-screen phones (a Pixel, not the
 *   Titan). The session's own prompt (Claude Code's box, the shell line) is
 *   the only input line you see: this row is controls, not a second box.
 *
 *   The on-screen keyboard types into a hidden textarea, so swipe typing,
 *   corrections and the keyboard's mic work as in any app, and every edit is
 *   mirrored into the session at once (Backspace back to where the text
 *   changed, then the rest). Send, or the keyboard's Enter, presses Enter.
 *   Backspace on an empty box deletes in the session.
 *
 *   Two faces, one row: a hint ("Tap to type") with Send, or the terminal keys
 *   in ONE strip that scrolls end to end (nothing pinned; keys fire on click,
 *   so a swipe that starts on a key scrolls). A key from the strip moves the
 *   session's cursor, so the box forgets what it mirrored and starts fresh.
 *
 *   The textarea stays mounted and focused in both faces, so the keyboard
 *   never drops when they swap. A textarea, not an input: Chrome shows its
 *   password/card/address strip above the keyboard for inputs.
 *
 *   Sticky Ctrl: armed, the next letter typed becomes its control code.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Braces, ChevronDown, CornerDownLeft, Keyboard } from 'lucide-react';
import { ARROWS, KEY, MORE_KEYS, PINNED } from './KeyRow';
import { wrapForPaste } from '../Composer';

export interface CommandLineHandle {
  focus: () => void;
  blur: () => void;
  /** Add text at the end of the box (an uploaded file's path). */
  insert: (text: string) => void;
  /** Something else typed into the session: forget what the box mirrored. */
  reset: () => void;
}

export interface CommandLineProps {
  /** Raw keys for the session (the key face, Backspace on empty, Ctrl+letter). */
  sendInput: (data: string) => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onCtrlUsed: () => void;
  onOpenSnippets: () => void;
  /** Put the soft keyboard away (the dock is folded while it is up). */
  onHide?: () => void;
  /** Which face shows (the screen resets it when the keyboard goes away). */
  keysView: boolean;
  onKeysView: (on: boolean) => void;
  /** Where Send goes, for the placeholder ("Ops Suite"). */
  target?: string;
  /** Whether the program asked for bracketed paste (Claude Code does). */
  bracketedPaste: () => boolean;
  /** The session is asking a question (a permission prompt): typing stays in
   *  the box until it is answered, so a digit in a sentence never picks an
   *  option. */
  hold?: boolean;
  /** The soft keyboard is on screen (drives the hint). */
  keyboardUp?: boolean;
  /** Not connected: Send waits. The box stays usable, so a reconnect blip
   *  never drops the keyboard mid-word. */
  offline?: boolean;
}

/** Ctrl+letter as the byte a terminal expects (Ctrl+C is 0x03). */
export function ctrlCode(ch: string): string | null {
  if (!/^[a-zA-Z]$/.test(ch)) return null;
  return String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64);
}

/** Keep the box focused (and the keyboard up) when a button is touched. */
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

const STRIP_KEY = `${KEY} h-10 min-w-11 px-3`;

export const CommandLine = forwardRef<CommandLineHandle, CommandLineProps>(function CommandLine(
  { sendInput, ctrlArmed, onToggleCtrl, onCtrlUsed, onOpenSnippets, onHide, keysView, onKeysView, target, bracketedPaste, hold: holdProp = false, keyboardUp = false, offline = false },
  ref,
) {
  // What the box holds, and (sentRef) what of it is already in the session.
  // The box is the keyboard's text field only; the session's own prompt is
  // the one input line you see. Every edit is mirrored there at once.
  const [text, setText] = useState('');
  // Tapping the hint while held types the words in anyway (a y/n prompt
  // that wants them); cleared when the question goes.
  const [released, setReleased] = useState(false);
  useEffect(() => { if (!holdProp) setReleased(false); }, [holdProp]);
  const hold = holdProp && !released;
  const sentRef = useRef('');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  /** Make the session's line match the box: delete back to where they
   *  differ, type the rest. Counted in characters, not UTF-16 units, so an
   *  emoji is one Backspace. */
  const mirror = (next: string, opts: { paste?: boolean } = {}) => {
    setText(next);
    // Offline (a dropped write would desync the line) or a question on
    // screen: hold it in the box; the effect below catches up.
    if (offline || hold) return;
    const prev = Array.from(sentRef.current);
    const want = Array.from(next);
    let same = 0;
    while (same < prev.length && same < want.length && prev[same] === want[same]) same++;
    const added = want.slice(same).join('');
    // Pasted, dictated or inserted text goes as a paste, as the composer
    // does: Claude Code must not read a leading "!" or "/" as typed keys.
    const asPaste = !!added && (opts.paste || pastingRef.current || added.length > 24);
    pastingRef.current = false;
    const data = '\x7f'.repeat(prev.length - same)
      + (asPaste ? wrapForPaste(added, bracketedPaste()) : added);
    if (data) sendInput(data);
    sentRef.current = next;
  };
  const pastingRef = useRef(false);
  // Back online, or the question answered: send what was held.
  useEffect(() => {
    if (!offline && !hold && text !== sentRef.current) mirror(text);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline, hold]);

  /** Raise the keyboard on the box. Android Back hides the keyboard but
   *  leaves the box focused, and focus() on a focused box is a no-op, so
   *  cycle it. */
  const focusBox = () => {
    const el = boxRef.current;
    if (!el) return;
    if (document.activeElement === el) el.blur();
    el.focus();
  };

  /** Forget the box without touching the session (after Enter, or a key
   *  that moves the session's cursor so the box no longer matches it). */
  const forget = () => {
    sentRef.current = '';
    setText('');
  };

  useImperativeHandle(ref, () => ({
    focus: focusBox,
    reset: () => forget(),
    blur: () => boxRef.current?.blur(),
    insert: (t: string) => {
      const prev = sentRef.current;
      mirror(prev && !/\s$/.test(prev) ? `${prev} ${t}` : prev + t, { paste: true });
      onKeysView(false);
      boxRef.current?.focus();
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [onKeysView]);

  const send = () => {
    if (offline) return;
    // A question is on screen: Enter would pick its highlighted option with
    // your words still held. Words wait; an empty Enter still goes.
    if (hold && text) return;
    // The words are already on the session's line: Enter is all Send adds.
    sendInput('\r');
    forget();
    boxRef.current?.focus();
  };

  const key = (seq: string) => {
    forget();
    sendInput(seq);
  };

  const box = (
    <textarea
      ref={boxRef}
      data-pl-composer=""
      rows={1}
      value={text}
      enterKeyHint="send"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      autoComplete="off"
      aria-label={target ? `Type into ${target}` : 'Type into the session'}
      onPaste={() => { pastingRef.current = true; }}
      onChange={(e) => {
        const next = e.target.value;
        // Ctrl armed and one letter added at the end: that is a control key.
        if (ctrlArmed && next.length === text.length + 1 && next.startsWith(text)) {
          const code = ctrlCode(next.slice(-1));
          if (code) {
            onCtrlUsed();
            forget();
            sendInput(code);
            return;
          }
        }
        if (keysView && next !== text) onKeysView(false);
        // A break typed at the end is Enter arriving without a keydown
        // (mid-composition, an odd keyboard): send. Breaks inside pasted or
        // dictated text become spaces, so no line runs on its own.
        if (/\n/.test(next)) {
          const typedEnter = next.length === text.length + 1 && next.endsWith('\n') && next.startsWith(text);
          if (typedEnter) { send(); return; }
          mirror(next.replace(/\r?\n/g, ' '));
          return;
        }
        mirror(next);
      }}
      onKeyDown={(e) => {
        // Keys typed here stay here: the terminal must not see them too.
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        } else if (e.key === 'Backspace' && text === '') {
          e.preventDefault();
          sendInput('\x7f');
        }
      }}
      className="pl-cmdline-in hidden-face"
    />
  );

  const strip = (
    <div ref={stripRef} className="pl-cmdline-strip" role="toolbar" aria-label="Terminal keys">
      {PINNED.slice(0, 1).map((k) => (
        <button key={k.label} type="button" onPointerDown={keepFocus} onClick={() => key(k.seq)} className={STRIP_KEY} aria-label={k.aria}>{k.label}</button>
      ))}
      <button
        type="button"
        onPointerDown={keepFocus}
        onClick={onToggleCtrl}
        aria-pressed={ctrlArmed}
        aria-label="Control, applies to the next letter"
        className={`${STRIP_KEY} ${ctrlArmed ? '!bg-accent-soft !text-accent-hi' : ''}`}
      >
        Ctrl
      </button>
      {ARROWS.map((k) => (
        <button key={k.aria} type="button" onPointerDown={keepFocus} onClick={() => key(k.seq)} className={STRIP_KEY} aria-label={k.aria}>{k.icon}</button>
      ))}
      <button type="button" onPointerDown={keepFocus} onClick={() => key('\r')} className={STRIP_KEY} aria-label="Enter">
        <CornerDownLeft className="w-4 h-4" strokeWidth={1.75} />
      </button>
      {PINNED.slice(1).map((k) => (
        <button key={k.label} type="button" onPointerDown={keepFocus} onClick={() => key(k.seq)} className={STRIP_KEY} aria-label={k.aria}>{k.label}</button>
      ))}
      {MORE_KEYS.map((k) => (
        <button key={k.label} type="button" onPointerDown={keepFocus} onClick={() => key(k.seq)} className={STRIP_KEY} aria-label={k.aria}>{k.label}</button>
      ))}
      <button type="button" onPointerDown={keepFocus} onClick={onOpenSnippets} className={`${STRIP_KEY} text-fg-2`} aria-label="Snippets" title="Snippets: saved commands">
        <Braces className="w-4 h-4" strokeWidth={1.75} />
      </button>
      {onHide && (
        <button type="button" onPointerDown={keepFocus} onClick={onHide} className={`${STRIP_KEY} text-fg-2`} aria-label="Hide the keyboard" title="Hide the keyboard">
          <ChevronDown className="w-4 h-4" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );

  // One tree for both faces: the box keeps its place (and its focus, so the
  // keyboard stays up); only what sits beside it changes.
  return (
    <form
      className="pl-cmdline"
      onSubmit={(e) => { e.preventDefault(); send(); }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="pl-cmdline-mode"
        onPointerDown={keepFocus}
        onClick={() => onKeysView(!keysView)}
        aria-label={keysView ? 'Back to typing' : 'Show terminal keys'}
        title={keysView ? 'Back to typing' : 'Esc, Ctrl, arrows and more'}
      >
        {keysView
          ? <span className="font-mono text-[13px]">abc</span>
          : <Keyboard className="w-4 h-4" strokeWidth={1.75} />}
      </button>
      {box}
      {keysView ? strip : (
        <button
          type="button"
          className="pl-cmdline-hint"
          onPointerDown={keepFocus}
          onClick={() => {
            if (hold && text) setReleased(true);
            focusBox();
          }}
        >
          {hold && text
            ? 'Held for the question. Tap to type it in'
            : keyboardUp
              ? `Typing into ${target || 'the session'}`
              : 'Tap to type'}
        </button>
      )}
      {!keysView && (
        <button
          type="submit"
          className={`pl-cmdline-send${text ? '' : ' idle'}`}
          // Tapping Send must not close the keyboard first.
          onPointerDown={keepFocus}
          disabled={offline}
          aria-label={text ? 'Send (Enter)' : 'Press Enter'}
          title={text ? 'Send (Enter)' : 'Press Enter'}
        >
          <CornerDownLeft className="w-4 h-4" strokeWidth={2} />
          <span>{text ? 'Send' : 'Enter'}</span>
        </button>
      )}
    </form>
  );
});
