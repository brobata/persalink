/**
 * @file CommandLine
 * @description The typing line for touch-screen phones (a Pixel, not the
 *   Titan). The on-screen keyboard types into a real text box, so swipe
 *   typing, autocorrect, the keyboard's own mic and the edit cursor all work
 *   the way they do in any app. Nothing reaches the session until Send (or the
 *   keyboard's Enter key). Send with the box empty presses Enter alone, which
 *   answers a "press Enter" prompt. Backspace on an empty box deletes in the
 *   session.
 *
 *   The keyboard icon on the left switches to typing live, straight into the
 *   session, for programs that read one key at a time (vim, top, a y/n read).
 *   The phone screen brings the line back when the keyboard goes away.
 *
 *   Sticky Ctrl from the key row applies here too: with Ctrl armed, the next
 *   letter typed becomes its control code and goes straight to the session.
 */

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { CornerDownLeft, Keyboard } from 'lucide-react';

export interface CommandLineHandle {
  focus: () => void;
  blur: () => void;
  /** Add text at the end of the box (an uploaded file's path). */
  insert: (text: string) => void;
}

export interface CommandLineProps {
  /** Send what is in the box, then Enter. Empty text means Enter alone. */
  onSend: (text: string) => void;
  /** Raw keys for the session (Backspace on an empty box, Ctrl+letter). */
  sendInput: (data: string) => void;
  ctrlArmed: boolean;
  onCtrlUsed: () => void;
  /** Switch to typing straight into the session. */
  onLive: () => void;
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

export const CommandLine = forwardRef<CommandLineHandle, CommandLineProps>(function CommandLine(
  { onSend, sendInput, ctrlArmed, onCtrlUsed, onLive, target, offline = false },
  ref,
) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = inputRef.current;
      if (!el) return;
      // Android Back hides the keyboard but leaves the box focused, and a
      // second focus() on a focused box is a no-op: cycle it so it opens.
      if (document.activeElement === el) el.blur();
      el.focus();
    },
    blur: () => inputRef.current?.blur(),
    insert: (t: string) => {
      setText((prev) => (prev && !/\s$/.test(prev) ? `${prev} ${t}` : prev + t));
      inputRef.current?.focus();
    },
  }), []);

  const send = () => {
    if (offline) return;
    onSend(text);
    setText('');
    // Keep the keyboard up for the next command.
    inputRef.current?.focus();
  };

  return (
    <form
      className="pl-cmdline"
      onSubmit={(e) => { e.preventDefault(); send(); }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="pl-cmdline-mode"
        // Keep the box focused until the session takes the keyboard over.
        onPointerDown={(e) => e.preventDefault()}
        onClick={onLive}
        aria-label="Type live, straight into the session"
        title="Type live, straight into the session (for vim, top, single keys)"
      >
        <Keyboard className="w-4 h-4" strokeWidth={1.75} />
      </button>
      <input
        ref={inputRef}
        data-pl-composer=""
        type="text"
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
          setText(next);
        }}
        onKeyDown={(e) => {
          // Keys typed here stay here: the terminal must not see them too.
          e.stopPropagation();
          if (e.key === 'Backspace' && text === '' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            sendInput('\x7f');
          }
        }}
        className="pl-cmdline-in"
      />
      <button
        type="submit"
        className={`pl-cmdline-send${text ? '' : ' idle'}`}
        // Tapping Send must not close the keyboard first.
        onPointerDown={(e) => e.preventDefault()}
        disabled={offline}
        aria-label={text ? 'Send, then Enter' : 'Press Enter'}
        title={text ? 'Send, then Enter' : 'Press Enter'}
      >
        <CornerDownLeft className="w-4 h-4" strokeWidth={2} />
        <span>{text ? 'Send' : 'Enter'}</span>
      </button>
    </form>
  );
});
