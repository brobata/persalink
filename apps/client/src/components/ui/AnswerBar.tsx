/**
 * @file AnswerBar
 * @description The phone's answer bar for the agent on screen: one question
 *   line (tap it for the whole question and every option) above the answer
 *   chips ("Yes · Always · No, explain") and a reply-by-voice chip. The first
 *   chip is the screen's one accent while the bar shows. It sits between the
 *   terminal and the dock, and stays pinned above the key row when the
 *   keyboard is up, so what needs you never disappears under it.
 */

import { ChevronUp, Mic } from 'lucide-react';
import type { PromptOption } from '../../lib/claudePrompt';
import { AnswerChips } from './AnswerChips';
import { StateGlyph } from './StateGlyph';

export function AnswerBar({ name, question, options, onAnswer, onReply, onOpenQuestion }: {
  /** The session's name, for the spoken label. */
  name: string;
  question: string;
  options: readonly PromptOption[];
  onAnswer: (o: PromptOption) => void;
  onReply: () => void;
  onOpenQuestion: () => void;
}) {
  return (
    <div className="pl-abar" role="group" aria-label={`Answer ${name}`}>
      <button
        type="button"
        className="pl-abar-q"
        onPointerDown={(e) => e.preventDefault()}
        onClick={onOpenQuestion}
        aria-label={`Open the full question: ${question || 'waiting for you'}`}
      >
        <StateGlyph state="waiting" size={10} />
        <span className="qt">{question || `${name} is waiting for you`}</span>
        <ChevronUp className="w-3.5 h-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />
      </button>
      <AnswerChips
        className="pl-abar-c"
        options={options}
        onAnswer={onAnswer}
        onReply={onReply}
        onOpenQuestion={onOpenQuestion}
        replyIcon={<Mic className="w-4 h-4" strokeWidth={1.75} />}
      />
    </div>
  );
}
