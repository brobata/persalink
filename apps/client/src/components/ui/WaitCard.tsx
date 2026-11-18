/**
 * @file WaitCard
 * @description The one Needs-you card, on phone Home, the Titan and desktop
 *   Home. Name and how long it has waited (tap to open), the question, and
 *   its answers inline: the agent's own options as chips, read from its
 *   screen (lib/useInlineAnswer), so most prompts are answered without
 *   opening anything. "No, explain" and the reply chip open the session with
 *   the composer. An error, or a prompt that cannot be read, offers Open.
 *
 *   Send rule: on desktop a click sends at once and the status bar says so.
 *   On touch a tap is held for 3s first ("Sending 'Yes' in 3s · Undo", with
 *   a draining line), because a pocket tap on a list is the real mis-tap
 *   risk; nothing is typed until it lands. Either way the screen is read
 *   again right before typing, and nothing is sent if the question changed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronRight, Mic } from 'lucide-react';
import type { SessionInfo } from '@persalink/shared/protocol';
import { AnswerChips } from './AnswerChips';
import { StateGlyph } from './StateGlyph';
import { chipLabel, type PromptOption } from '../../lib/claudePrompt';
import { peekKey } from '../../lib/inlineAnswer';
import { sendInlineAnswer, useWaitingPrompt } from '../../lib/useInlineAnswer';
import { waitAge } from '../../lib/sessionOrder';
import { previewLine, sessionTitle, stateKey, stateWord } from '../../lib/sessionState';

const GRACE_MS = 3000;
/** After a send the card says so at least this long, even if the screen ticks. */
const SENT_HOLD_MS = 6000;

export interface WaitCardProps {
  session: SessionInfo;
  /** 'touch' = phone and Titan (44px chips, held send); 'desktop' = sends at once. */
  variant: 'touch' | 'desktop';
  /** This card carries the screen's one accent (its first chip, or Open). */
  accent: boolean;
  onOpen: (s: SessionInfo) => void;
  /** Open with the composer up (reply in your own words, "No, explain"). */
  onReply: (s: SessionInfo) => void;
  /** An answer was typed: "Sent 'Yes' to Olive". */
  onSent?: (s: SessionInfo, label: string) => void;
  /** Nothing was typed, and why. */
  onNotSent?: (s: SessionInfo, reason: 'changed' | 'failed') => void;
}

export function WaitCard({ session: s, variant, accent, onOpen, onReply, onSent, onNotSent }: WaitCardProps) {
  const k = stateKey(s);
  const { prompt } = useWaitingPrompt(s);
  const touch = variant === 'touch';
  const key = peekKey(s);

  // Held answer (touch): what, and when it lands.
  const [held, setHeld] = useState<{ o: PromptOption; until: number } | null>(null);
  const [left, setLeft] = useState(0);
  // Typed, until the session's screen moves on.
  const [sent, setSent] = useState<{ label: string; key: string; at: number } | null>(null);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const live = useRef(true);
  useEffect(() => () => {
    live.current = false;
    if (timer.current) clearTimeout(timer.current);
    if (tick.current) clearInterval(tick.current);
  }, []);

  const commit = useCallback(async (o: PromptOption) => {
    if (!prompt) return;
    setBusy(true);
    const r = await sendInlineAnswer(s.id, prompt, o);
    // Report first: a sent answer moves the agent out of Needs you, so this
    // card may already be gone.
    if (r === 'sent') onSent?.(s, chipLabel(o));
    else onNotSent?.(s, r);
    if (!live.current) return;
    setBusy(false);
    if (r === 'sent') {
      setSent({ label: chipLabel(o), key, at: Date.now() });
      // Re-render when the hold ends, so the chips can come back if the
      // agent is still asking (a new question, or the key did not land).
      timer.current = setTimeout(() => { if (live.current) setTick((n) => n + 1); }, SENT_HOLD_MS);
    }
  }, [prompt, s, key, onSent, onNotSent]);

  const answer = (o: PromptOption) => {
    if (busy || held) return;
    if (!touch) { void commit(o); return; }
    const until = Date.now() + GRACE_MS;
    setHeld({ o, until });
    setLeft(GRACE_MS);
    tick.current = setInterval(() => setLeft(Math.max(0, until - Date.now())), 250);
    timer.current = setTimeout(() => {
      if (tick.current) clearInterval(tick.current);
      tick.current = null;
      timer.current = null;
      setHeld(null);
      void commit(o);
    }, GRACE_MS);
  };

  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    if (tick.current) clearInterval(tick.current);
    timer.current = null;
    tick.current = null;
    setHeld(null);
  };

  const showSent = !!sent && (sent.key === key || Date.now() - sent.at < SENT_HOLD_MS);
  const question = prompt?.question || previewLine(s, k) || (k === 'error' ? 'Stopped on an error' : 'Waiting for you');
  const title = sessionTitle(s);
  const age = k === 'error' ? 'Error' : waitAge(s);

  let answers;
  if (held) {
    answers = (
      <div className="pl-sending" role="status">
        <span className="tx">
          Sending “{chipLabel(held.o)}” in <span className="tnum">{Math.max(1, Math.ceil(left / 1000))}s</span>
        </span>
        <button type="button" className="ub" onClick={undo}>Undo</button>
        <i className="bar" style={{ animationDuration: `${GRACE_MS}ms` }} aria-hidden />
      </div>
    );
  } else if (busy || showSent) {
    answers = (
      <div className="pl-sending" role="status">
        <span className="tx">{busy ? 'Sending…' : `Sent “${sent!.label}”`}</span>
      </div>
    );
  } else if (prompt && k === 'waiting') {
    answers = (
      <AnswerChips
        className="pl-wc-ans"
        options={prompt.options}
        accent={accent}
        onAnswer={answer}
        onReply={() => onReply(s)}
        onOpenQuestion={() => onOpen(s)}
        replyIcon={touch ? <Mic className="w-4 h-4" strokeWidth={1.75} /> : undefined}
      />
    );
  } else {
    answers = (
      <button type="button" className={`pl-btn${touch ? '' : ' sm'}${accent ? ' pri' : ''} pl-wc-open`} onClick={() => onOpen(s)}>
        Open and answer<ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
      </button>
    );
  }

  return (
    <article className={`pl-wc${touch ? ' touch' : ''}`} data-flip={s.id}>
      <button
        type="button"
        className="pl-wc-r1"
        onClick={() => onOpen(s)}
        title={[title, s.profileName && s.profileName !== title ? s.profileName : '', s.id].filter(Boolean).join(' · ')}
        aria-label={`Open ${title}, ${stateWord(s, k).toLowerCase()}`}
      >
        <StateGlyph state={k} size={12} />
        <span className="nm">{title}</span>
        <span className="age tnum">{age}</span>
        {touch
          ? <ChevronRight className="go w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
          : <span className="go">Open<ChevronRight className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden /></span>}
      </button>
      <p className="pl-wc-q" title={s.preview || undefined}>{question}</p>
      <div className="pl-wc-a">{answers}</div>
    </article>
  );
}
