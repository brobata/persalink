/**
 * @file AnswerChips
 * @description Answer a waiting agent in one tap. One chip per option with
 *   its full label (never shortened: "Always" and "No, explain" are the
 *   fixed names of the two long standard options, see lib/claudePrompt). The
 *   first chip is the screen's accented action. When the chips do not fit
 *   the row, the whole set collapses to one "Answer" button that opens the
 *   full question, instead of truncating anyone's words.
 *
 *   One send rule everywhere (useAnswerSend): a chip sends at once, and the
 *   confirmation slot says "Answered: Yes" for 3s with a Stop button. A key
 *   already sent cannot be taken back, so Stop is honest about what it does:
 *   it presses Esc, which interrupts Claude before the approved step runs on.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { chipLabel, isRedirectOption, type PromptOption } from '../../lib/claudePrompt';

export function AnswerChips({ options, onAnswer, onReply, onOpenQuestion, accent = true, className = '' }: {
  options: readonly PromptOption[];
  /** A chip was tapped. The redirect option ("No, explain") goes to onReply when given. */
  onAnswer: (option: PromptOption) => void;
  /** Reply in your own words (the composer). */
  onReply?: () => void;
  /** Collapsed: the single "Answer" button opens the full question. */
  onOpenQuestion?: () => void;
  /** Accent the first chip (off where another control owns the accent). */
  accent?: boolean;
  className?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Fit check: a hidden copy of the full row is measured against the space
  // the row has. Runs on resize and whenever the options change.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const probe = measureRef.current;
    if (!row || !probe) return;
    const check = () => setCollapsed(probe.scrollWidth > row.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(row);
    return () => ro.disconnect();
  }, [options, onReply]);

  const pick = (o: PromptOption) => {
    if (isRedirectOption(o) && onReply) onReply();
    else onAnswer(o);
  };

  const chips = (probe: boolean) => (
    <>
      {options.map((o, i) => (
        <button
          key={o.key}
          type="button"
          tabIndex={probe ? -1 : undefined}
          className={`pl-chip${accent && i === 0 ? ' first' : ''}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={probe ? undefined : () => pick(o)}
          title={o.label}
          aria-label={o.label}
        >
          {chipLabel(o)}
        </button>
      ))}
      {onReply && (
        <button
          type="button"
          tabIndex={probe ? -1 : undefined}
          className="pl-chip icon"
          onPointerDown={(e) => e.preventDefault()}
          onClick={probe ? undefined : onReply}
          title="Reply in your own words"
          aria-label="Reply in your own words"
        >
          <MessageSquare className="w-4 h-4" strokeWidth={1.75} />
        </button>
      )}
    </>
  );

  return (
    <div ref={rowRef} className={`relative flex gap-1.5 min-w-0 overflow-hidden ${className}`} role="group" aria-label="Answer">
      <div ref={measureRef} aria-hidden className="absolute left-0 top-0 flex gap-1.5 invisible pointer-events-none">
        {chips(true)}
      </div>
      {collapsed ? (
        <button
          type="button"
          className={`pl-chip flex-1${accent ? ' first' : ''}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={onOpenQuestion}
        >
          Answer
        </button>
      ) : chips(false)}
    </div>
  );
}

export interface AnswerConfirmation {
  text: string;
  /** Interrupt (Esc) while the confirmation shows. */
  stop: () => void;
}

const CONFIRM_MS = 3000;

/**
 * The one send rule. `answer(option)` types the option's key at once and
 * returns nothing to wait for; `confirmation` is set for 3s so the screen's
 * confirmation slot can say what was sent and offer Stop.
 */
export function useAnswerSend(sendKeys: (data: string) => void): {
  answer: (o: PromptOption) => void;
  confirmation: AnswerConfirmation | null;
} {
  const [confirmation, setConfirmation] = useState<AnswerConfirmation | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = useRef(sendKeys);
  send.current = sendKeys;

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const answer = useCallback((o: PromptOption) => {
    send.current(o.key);
    if (timer.current) clearTimeout(timer.current);
    const done = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setConfirmation(null); };
    setConfirmation({
      text: `Answered: ${chipLabel(o)}`,
      stop: () => { send.current('\x1b'); done(); },
    });
    timer.current = setTimeout(done, CONFIRM_MS);
  }, []);

  return { answer, confirmation };
}

/** The confirmation slot's content: "Answered: Yes · Stop". */
export function AnswerConfirmationLine({ confirmation, className = '' }: {
  confirmation: AnswerConfirmation;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 min-w-0 motion-safe:animate-fade ${className}`} role="status">
      <span className="truncate text-fg-1 font-medium">{confirmation.text}</span>
      <button
        type="button"
        onPointerDown={(e) => e.preventDefault()}
        onClick={confirmation.stop}
        className="shrink-0 text-accent-hi font-medium hover:underline"
        title="Press Esc in the session to interrupt what was just approved"
      >
        Stop
      </button>
    </span>
  );
}
