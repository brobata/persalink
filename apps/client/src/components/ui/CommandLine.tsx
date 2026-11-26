/**
 * @file CommandLine
 * @description The one input row for touch-screen phones (a Pixel, not the
 *   Titan). It has two faces and only ever takes one row:
 *
 *   - Typing: a keys button, a real text box, Send. The on-screen keyboard
 *     types into the box, so swipe typing, autocorrect, the keyboard's own mic
 *     and the edit cursor work as in any app. Nothing reaches the session until
 *     Send (or the keyboard's Enter). Send with the box empty presses Enter
 *     alone. Backspace on an empty box deletes in the session.
 *   - Keys: Esc, Ctrl, arrows, Tab, Enter, ^C and the rest in ONE strip that
 *     scrolls end to end (nothing pinned, so a swipe anywhere moves it). Keys
 *     fire on click, so a swipe that starts on a key scrolls instead of
 *     pressing it. "abc" goes back to the box; typing a letter does too.
 *
 *   The box stays mounted and focused in both faces, so the soft keyboard
 *   never drops when the faces swap. It is a textarea, not an input: Chrome
 *   shows its password/card/address strip above the keyboard for inputs.
 *
 *   Sticky Ctrl: armed, the next letter typed becomes its control code and goes
 *   straight to the session. "Live" types straight into the session instead
 *   (vim, top, single-key reads) until the keyboard goes away.
 */

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Braces, ChevronDown, CornerDownLeft, Keyboard, TextCursorInput } from 'lucide-react';
import { ARROWS, KEY, MORE_KEYS, PINNED } from './KeyRow';

export interface CommandLineHandle {
  focus: () => void;
  blur: () => void;
  /** Add text at the end of the box (an uploaded file's path). */
  insert: (text: string) => void;
}

export interface CommandLineProps {
  /** Send what is in the box, then Enter. Empty text means Enter alone. */
  onSend: (text: string) => void;
  /** Raw keys for the session (the key face, Backspace on empty, Ctrl+letter). */
  sendInput: (data: string) => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onCtrlUsed: () => void;
  /** Switch to typing straight into the session. */
  onLive: () => void;
  onOpenSnippets: () => void;
  /** Put the soft keyboard away (the dock is folded while it is up). */
  onHide?: () => void;
  /** Which face shows (the screen resets it when the keyboard goes away). */
  keysView: boolean;
  onKeysView: (on: boolean) => void;
  /** Where Send goes, for the placeholder ("Ops Suite"). */
  target?: string;
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
  { onSend, sendInput, ctrlArmed, onToggleCtrl, onCtrlUsed, onLive, onOpenSnippets, onHide, keysView, onKeysView, target, offline = false },
  ref,
) {
  const [text, setText] = useState('');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = boxRef.current;
      if (!el) return;
      // Android Back hides the keyboard but leaves the box focused, and a
      // second focus() on a focused box is a no-op: cycle it so it opens.
      if (document.activeElement === el) el.blur();
      el.focus();
    },
    blur: () => boxRef.current?.blur(),
    insert: (t: string) => {
      setText((prev) => (prev && !/\s$/.test(prev) ? `${prev} ${t}` : prev + t));
      onKeysView(false);
      boxRef.current?.focus();
    },
  }), [onKeysView]);

  const send = (value = text) => {
    if (offline) return;
    onSend(value);
    setText('');
    boxRef.current?.focus();
  };

  const key = (seq: string) => sendInput(seq);

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
      aria-label={target ? `Command for ${target}` : 'Command'}
      placeholder={target ? `Type to ${target}` : 'Type a command'}
      onChange={(e) => {
        const next = e.target.value;
        // Ctrl armed and one letter added at the end: that is a control key.
        if (ctrlArmed && next.length === text.length + 1 && next.startsWith(text)) {
          const code = ctrlCode(next.slice(-1));
          if (code) {
            onCtrlUsed();
            sendInput(code);
            return;
          }
        }
        // Typing while the keys show: back to the box so you see the words.
        if (keysView && next !== text) onKeysView(false);
        // One visible line, so no hidden line breaks. A break typed at the
        // end is Enter arriving without a keydown (mid-composition, an odd
        // keyboard): send. Breaks inside pasted or dictated text become
        // spaces, so nothing you cannot see runs on its own.
        if (/\n/.test(next)) {
          const typedEnter = next.length === text.length + 1 && next.endsWith('\n') && next.startsWith(text);
          if (typedEnter) { send(text); return; }
          setText(next.replace(/\r?\n/g, ' '));
          return;
        }
        setText(next);
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
      className={keysView ? 'pl-cmdline-in hidden-face' : 'pl-cmdline-in'}
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
      <button
        type="button"
        onPointerDown={keepFocus}
        onClick={onLive}
        className={`${STRIP_KEY} gap-1.5 flex text-fg-2`}
        aria-label="Type live, straight into the session"
        title="Type live, straight into the session (vim, top, single keys)"
      >
        <TextCursorInput className="w-4 h-4" strokeWidth={1.75} />
        <span className="font-sans text-[12px]">Live</span>
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
          type="submit"
          className={`pl-cmdline-send${text ? '' : ' idle'}`}
          // Tapping Send must not close the keyboard first.
          onPointerDown={keepFocus}
          disabled={offline}
          aria-label={text ? 'Send, then Enter' : 'Press Enter'}
          title={text ? 'Send, then Enter' : 'Press Enter'}
        >
          <CornerDownLeft className="w-4 h-4" strokeWidth={2} />
          <span>{text ? 'Send' : 'Enter'}</span>
        </button>
      )}
    </form>
  );
});
