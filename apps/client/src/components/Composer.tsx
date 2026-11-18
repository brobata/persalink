/**
 * @file Composer
 * @description The one message box for a session, with its own dictation.
 *   Write, paste, edit or dictate, then send it as ONE message: a bracketed
 *   paste when the program asked for one (Claude Code does), then Enter.
 *   Dictation never types into the session by itself: what the mic hears
 *   lands in the box, the status line says "Dictated. Edit anything, then
 *   send.", and only Send (or Insert, without Enter) reaches the terminal.
 *
 *   Two shapes of the same component:
 *   - `sheet` (phones, the Titan): the shared Sheet, with what you are
 *     answering quoted on top, a 56px mic, Insert and Send.
 *   - `pane` (desktop): one row under the pane. Enter sends, Shift+Enter adds
 *     a line, Esc closes.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CornerDownLeft, Mic, Square } from 'lucide-react';
import { useVoiceInput } from '../lib/voiceInput';
import { useAppStore } from '../stores/appStore';
import { Sheet, useSheetClose } from './ui/Sheet';
import { IconButton } from './ui/IconButton';

/** What the message answers, quoted above the box (sheet only). */
export type ComposerContext =
  | { kind: 'question'; head: string; question: string }
  | { kind: 'lines'; label: string; lines: string[] };

export interface ComposerProps {
  /** Deliver the text and press Enter (the caller paste-wraps it). */
  onSend: (text: string) => void;
  /** Type the text in without Enter (sheet). */
  onInsert?: (text: string) => void;
  onClose: () => void;
  variant: 'pane' | 'sheet';
  /** Start listening as soon as it opens (the Dictate button). */
  listen?: boolean;
  /** Sheet title ("Message", "Tell Claude what to do instead"). */
  title?: string;
  /** Sheet meta line ("to Ops Suite"). */
  target?: string;
  context?: ComposerContext | null;
  /** What Send will do, said before anything is written. */
  hint?: string;
}

type Phase = 'idle' | 'listening' | 'finishing' | 'review';

/** Append a dictated phrase to what is already in the box. */
function joinText(prev: string, phrase: string): string {
  const p = phrase.trim();
  if (!p) return prev;
  if (!prev) return p;
  return /\s$/.test(prev) ? prev + p : `${prev} ${p}`;
}

/** The text and the mic, shared by both shapes. */
function useComposerVoice(listen: boolean) {
  const [text, setText] = useState('');
  const [dictated, setDictated] = useState(false);
  const [stopping, setStopping] = useState(false);
  // The box as it was when the mic started, so Discard drops only what was heard.
  const seedRef = useRef('');
  const voice = useVoiceInput(useCallback((phrase: string) => {
    setText((prev) => joinText(prev, phrase));
    setDictated(true);
  }, []));

  useEffect(() => {
    if (!voice.error) return;
    useAppStore.getState().pushNotification('error', voice.error, 'voice');
  }, [voice.error]);

  useEffect(() => { if (!voice.isListening) setStopping(false); }, [voice.isListening]);

  const textRef = useRef(text);
  textRef.current = text;
  const { start: voiceStart, stop: voiceStop } = voice;
  const startMic = useCallback(() => {
    seedRef.current = textRef.current;
    setStopping(false);
    voiceStart();
  }, [voiceStart]);
  const stopMic = useCallback(() => {
    setStopping(true);
    voiceStop();
  }, [voiceStop]);
  const toggleMic = () => (voice.isListening ? stopMic() : startMic());

  // The Dictate button opens the composer already listening.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !listen || !voice.isSupported) return;
    started.current = true;
    startMic();
  }, [listen, voice.isSupported, startMic]);

  const phase: Phase = voice.isListening ? (stopping ? 'finishing' : 'listening') : dictated ? 'review' : 'idle';
  const discard = () => { setText(seedRef.current); setDictated(false); };
  const reset = () => { setText(''); setDictated(false); seedRef.current = ''; };
  return { text, setText, phase, voice, toggleMic, stopMic, discard, reset };
}

export function Composer(props: ComposerProps) {
  if (props.variant === 'sheet') {
    return (
      <Sheet
        title={props.title ?? 'Message'}
        sub={props.target}
        onClose={props.onClose}
        label={props.title ?? 'Message'}
      >
        <ComposerSheetBody {...props} />
      </Sheet>
    );
  }
  return <ComposerRow {...props} />;
}

function ComposerSheetBody({ onSend, onInsert, listen = false, context, hint, target }: ComposerProps) {
  const close = useSheetClose();
  const { text, setText, phase, voice, toggleMic, stopMic, discard } = useComposerVoice(listen);
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = phase === 'listening' || phase === 'finishing';
  const has = text.trim().length > 0;

  // Typing starts in the box; dictation keeps the soft keyboard down.
  useEffect(() => {
    if (listen && voice.isSupported) return;
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [listen, voice.isSupported]);

  // Grow with the content up to a cap, like a chat box.
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 96), 180)}px`;
  }, [text]);

  const deliver = (enter: boolean) => {
    const t = text.trim();
    if (!t) return;
    if (voice.isListening) stopMic();
    close();
    if (enter) onSend(t);
    else onInsert?.(t);
  };

  let status: ReactNode;
  if (phase === 'listening') {
    status = (
      <>
        <span className="pl-live-dot" aria-hidden />
        <span className="text-accent-hi font-medium">Listening</span>
        <span className="ml-auto">Tap the mic to stop</span>
      </>
    );
  } else if (phase === 'finishing') {
    status = <span>Finishing the last words</span>;
  } else if (phase === 'review') {
    status = (
      <>
        <Check className="w-3.5 h-3.5 text-accent-hi" strokeWidth={2} aria-hidden />
        <span>Dictated. Edit anything, then send.</span>
      </>
    );
  } else {
    status = <span className="truncate">{hint ?? 'Sent as one message, then Enter'}</span>;
  }

  return (
    <div className="flex flex-col gap-3 px-2 pb-2">
      {context?.kind === 'question' && (
        <div className="pl-ctxq">
          <span className="block text-micro font-medium text-st-waiting tnum">{context.head}</span>
          <span className="block text-fg-1 font-medium line-clamp-2">{context.question}</span>
        </div>
      )}
      {context?.kind === 'lines' && context.lines.length > 0 && (
        <div className="pl-ctxq term" aria-label={context.label}>{context.lines.join('\n')}</div>
      )}
      <div className={`pl-cmp-field${phase === 'listening' ? ' live' : ''}`}>
        <textarea
          ref={ref}
          data-pl-composer=""
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Keys typed here stay here (the terminal must not see them).
            e.stopPropagation();
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              deliver(true);
            }
          }}
          readOnly={busy}
          rows={3}
          spellCheck
          aria-label={target ? `Message ${target}` : 'Message'}
          placeholder={busy ? 'Start talking…' : voice.isSupported ? 'Type, or tap the mic and talk' : 'Type a message'}
          className="block w-full min-h-24 max-h-[180px] resize-none bg-transparent border-0 outline-none px-3 py-2.5 text-[15px] leading-[22px] text-fg-1 placeholder:text-fg-3"
        />
      </div>
      <div className="flex items-center gap-2.5 min-h-5 text-meta text-fg-3" role="status" aria-live="polite">
        {status}
      </div>
      <div className="flex items-center gap-2">
        {voice.isSupported && (
          <button
            type="button"
            onClick={toggleMic}
            className={`pl-mic${phase === 'listening' ? ' on' : ''}`}
            aria-label={phase === 'listening' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={phase === 'listening'}
          >
            {phase === 'listening'
              ? <Square className="w-4 h-4" strokeWidth={2} fill="currentColor" />
              : <Mic className="w-5 h-5" strokeWidth={1.75} />}
          </button>
        )}
        <span className="flex-1" />
        {phase === 'review' && (
          <button type="button" className="pl-btn ghost" onClick={discard}>Discard</button>
        )}
        {onInsert && (
          <button
            type="button"
            className="pl-btn"
            onClick={() => deliver(false)}
            disabled={busy || !has}
            title="Type it in without pressing Enter"
          >
            Insert
          </button>
        )}
        <button type="button" className="pl-btn pri" onClick={() => deliver(true)} disabled={busy || !has}>
          Send
          <CornerDownLeft className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function ComposerRow({ onSend, onClose, listen = false }: ComposerProps) {
  const { text, setText, phase, voice, toggleMic, stopMic, reset } = useComposerVoice(listen);
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = phase === 'listening' || phase === 'finishing';

  useEffect(() => { ref.current?.focus(); }, []);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [text]);

  const send = () => {
    if (!text.trim() || busy) return;
    if (voice.isListening) stopMic();
    onSend(text);
    reset();
    ref.current?.focus();
  };

  const placeholder = phase === 'listening'
    ? 'Listening… click the mic to stop'
    : phase === 'review'
      ? 'Dictated. Edit anything, then send'
      : 'Message: Enter to send, Shift+Enter for a new line, Esc to close';

  return (
    <div className="shrink-0 flex items-end gap-2 border-t border-line bg-bg-1 px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        data-pl-composer=""
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        readOnly={busy}
        rows={1}
        placeholder={placeholder}
        className={`flex-1 min-w-0 resize-none bg-bg-term border rounded-[6px] text-fg-1 placeholder:text-fg-3 outline-none px-2.5 py-1.5 text-[12.5px] font-mono ${
          phase === 'listening' ? 'border-accent/45 shadow-(--accent-glow)' : 'border-line-2 focus:border-line-3'
        }`}
        spellCheck
      />
      {voice.isSupported && (
        <IconButton
          label={phase === 'listening' ? 'Stop dictation' : 'Dictate into the message'}
          pressed={phase === 'listening'}
          onClick={toggleMic}
          className={phase === 'listening' ? 'text-accent-hi!' : ''}
        >
          <Mic className="w-4 h-4" strokeWidth={1.75} />
        </IconButton>
      )}
      <button type="button" onClick={send} disabled={!text.trim() || busy} className="pl-btn pri sm" title="Send (Enter)">
        Send
      </button>
      <button type="button" onClick={onClose} className="pl-btn ghost sm" title="Close (Esc)">
        Close
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
