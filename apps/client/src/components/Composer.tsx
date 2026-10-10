/**
 * @file Composer
 * @description A real text box for writing to the session: paste, edit,
 *   select and dictate like any text field, then send it as ONE message.
 *   Typing a multi-line message straight into a terminal is miserable (every
 *   newline submits); the composer sends the text as a bracketed paste when
 *   the program asked for one (Claude Code does), then presses Enter.
 *   Enter sends, Shift+Enter adds a line, Esc closes.
 */

import { useEffect, useRef, useState } from 'react';

export function Composer({ onSend, onClose, variant }: {
  /** Deliver the text to the session (already paste-wrapped by the caller). */
  onSend: (text: string) => void;
  onClose: () => void;
  variant: 'pane' | 'sheet';
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  // Grow with the content up to a cap, like a chat box.
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, variant === 'sheet' ? 200 : 240)}px`;
  }, [text, variant]);

  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText('');
    ref.current?.focus();
  };

  const touch = variant === 'sheet';
  return (
    <div
      className={`shrink-0 flex items-end gap-2 border-t border-zinc-800 bg-zinc-900 ${
        touch ? 'px-3 py-2 pb-[max(8px,env(safe-area-inset-bottom))]' : 'px-2 py-1.5'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        data-pl-composer=""
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Keys typed here stay here (the pane must not treat them as input).
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touch) {
            e.preventDefault();
            send();
          }
        }}
        rows={1}
        placeholder={touch ? 'Message…' : 'Message — Enter to send, Shift+Enter for a new line, Esc to close'}
        className={`flex-1 min-w-0 resize-none bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 font-mono ${
          touch ? 'px-3 py-2 text-[15px]' : 'px-2.5 py-1.5 text-xs'
        }`}
        spellCheck
      />
      <button
        onClick={send}
        disabled={!text.trim()}
        className={`shrink-0 rounded-lg bg-sky-600 text-white disabled:bg-zinc-800 disabled:text-zinc-600 transition-colors ${
          touch ? 'px-4 py-2 text-sm' : 'px-3 py-1.5 text-xs'
        }`}
        title="Send (Enter)"
      >
        Send
      </button>
      <button
        onClick={onClose}
        className={`shrink-0 text-zinc-500 hover:text-zinc-200 ${touch ? 'px-2 py-2 text-sm' : 'px-1.5 py-1.5 text-xs'}`}
        title="Close (Esc)"
      >
        ×
      </button>
    </div>
  );
}

/** Wrap text for the terminal: CR line endings (what Enter sends), inside
 *  bracketed-paste markers when the program enabled them so newlines don't
 *  submit early. Paste-end markers inside the text are stripped — they would
 *  end the paste early and let the rest run as typed input. */
export function wrapForPaste(text: string, bracketed: boolean): string {
  const body = text.replace(/\x1b\[20[01]~/g, '').replace(/\r?\n/g, '\r');
  return bracketed ? `\x1b[200~${body}\x1b[201~` : body;
}
