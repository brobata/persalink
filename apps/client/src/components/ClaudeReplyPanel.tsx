/**
 * @file ClaudeReplyPanel
 * @description Claude, on demand. Two surfaces built on one copy list:
 *   - ClaudeSheet (phones, the Titan): the shared Sheet with two tabs.
 *     Answer shows the whole waiting question and every option at full
 *     length, one tap each, plus "Reply in your words". Copy from Claude
 *     shows the last reply and each of its code blocks.
 *   - ClaudeReplyPanel (desktop panes): the copy list as an in-pane dropdown.
 *   Replies come from Claude Code's transcript, not the terminal: the
 *   terminal shows them hard-wrapped with a gutter, so copying a config or a
 *   long command off the screen drags indentation and line breaks along.
 */

import { useEffect, useState } from 'react';
import { Check, Copy, Mic } from 'lucide-react';
import type { ClaudeReplyState } from '../stores/appStore';
import { Sheet, useSheetClose } from './ui/Sheet';
import { StateGlyph } from './ui/StateGlyph';
import { copyTextToClipboard } from '../lib/clipboardBridge';
import { useAppStore } from '../stores/appStore';
import type { ClaudePrompt, PromptOption } from '../lib/claudePrompt';

const PREVIEW_LINES = 6;

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string) => {
    if (await copyTextToClipboard(text)) {
      setCopied(key);
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1200);
    } else {
      useAppStore.getState().pushNotification('error', 'Copy blocked by browser', 'copy');
    }
  };
  return { copied, copy };
}

function CopyMark({ done }: { done: boolean }) {
  return done
    ? <Check className="w-3.5 h-3.5 text-accent-hi" strokeWidth={2} />
    : <Copy className="w-3.5 h-3.5" strokeWidth={1.75} />;
}

/** The last reply's code blocks, each one tap to copy. */
function CopyList({ state, copied, copy }: {
  state: ClaudeReplyState;
  copied: string | null;
  copy: (key: string, text: string) => void;
}) {
  if (state === 'loading') {
    return <div className="px-3 py-6 text-center text-body text-fg-3">Reading Claude&apos;s last reply…</div>;
  }
  if (!state.found) {
    return <div className="px-3 py-6 text-center text-body text-fg-2">{state.reason}</div>;
  }
  return (
    <>
      {state.blocks.length === 0 && (
        <div className="px-1 pb-2 text-meta text-fg-3">No code blocks in the last reply.</div>
      )}
      {state.blocks.map((block, i) => {
        const lines = block.code.split('\n');
        const key = `block-${i}`;
        return (
          <button
            key={key}
            type="button"
            onClick={() => copy(key, block.code)}
            className="group w-full text-left mb-2 rounded-[10px] border border-line bg-bg-term hover:border-line-3 transition-colors duration-(--d-press)"
            title="Copy this block"
          >
            <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-line">
              <span className="text-micro font-mono text-fg-3">
                {block.lang || 'code'} · {lines.length} line{lines.length === 1 ? '' : 's'}
              </span>
              <span className="flex items-center gap-1 text-meta text-fg-2 group-hover:text-fg-1">
                <CopyMark done={copied === key} />
                {copied === key ? 'Copied' : 'Copy'}
              </span>
            </div>
            <pre className="px-2.5 py-2 text-[12px] leading-4 text-[#e3e3e8] font-mono whitespace-pre overflow-hidden">
              {lines.slice(0, PREVIEW_LINES).join('\n')}
              {lines.length > PREVIEW_LINES && <span className="text-fg-3">{`\n… ${lines.length - PREVIEW_LINES} more`}</span>}
            </pre>
          </button>
        );
      })}
    </>
  );
}

export type ClaudeTab = 'answer' | 'copy';

export function ClaudeSheet({ tab, onTab, name, prompt, waiting, onAnswer, onReply, reply, onRequestReply, onClose }: {
  tab: ClaudeTab;
  onTab: (tab: ClaudeTab) => void;
  /** The session's name. */
  name: string;
  /** The numbered question on screen, when the agent waits on one. */
  prompt: ClaudePrompt | null;
  /** "Waiting 4m" while it waits, else null. */
  waiting: string | null;
  onAnswer: (o: PromptOption) => void;
  onReply: () => void;
  /** The last reply, once asked for. */
  reply: ClaudeReplyState | null;
  onRequestReply: () => void;
  onClose: () => void;
}) {
  const { copied, copy } = useCopy();
  // The copy tab asks the server for the transcript the first time it shows.
  useEffect(() => {
    if (tab === 'copy' && reply === null) onRequestReply();
  }, [tab, reply, onRequestReply]);

  const canCopyAll = tab === 'copy' && typeof reply === 'object' && reply !== null && reply.found;
  return (
    <Sheet
      title="Claude"
      sub={name}
      onClose={onClose}
      contentKey={tab}
      headExtra={canCopyAll ? (
        <button
          type="button"
          onClick={() => copy('reply', reply.text)}
          className="pl-btn sm"
          title="Copy the whole reply as markdown"
        >
          <CopyMark done={copied === 'reply'} />
          Whole reply
        </button>
      ) : undefined}
    >
      <div className="pl-seg" role="tablist" aria-label="Claude">
        <button type="button" role="tab" aria-selected={tab === 'answer'} className={tab === 'answer' ? 'on' : ''} onClick={() => onTab('answer')}>
          {waiting && <StateGlyph state="waiting" size={10} />}
          Answer
        </button>
        <button type="button" role="tab" aria-selected={tab === 'copy'} className={tab === 'copy' ? 'on' : ''} onClick={() => onTab('copy')}>
          Copy from Claude
        </button>
      </div>
      {tab === 'answer'
        ? <AnswerTab name={name} prompt={prompt} waiting={waiting} onAnswer={onAnswer} onReply={onReply} />
        : reply === null
          ? <div className="px-3 py-6 text-center text-body text-fg-3">Reading Claude&apos;s last reply…</div>
          : <div className="px-1"><CopyList state={reply} copied={copied} copy={copy} /></div>}
    </Sheet>
  );
}

function AnswerTab({ name, prompt, waiting, onAnswer, onReply }: {
  name: string;
  prompt: ClaudePrompt | null;
  waiting: string | null;
  onAnswer: (o: PromptOption) => void;
  onReply: () => void;
}) {
  const close = useSheetClose();
  if (!prompt) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-6 text-center text-body text-fg-2">
        <span>{waiting ? `${name} is waiting, but not on a question with options.` : `Nothing is waiting in ${name}.`}</span>
        {waiting && (
          <button type="button" className="pl-btn" onClick={() => { close(); onReply(); }}>
            <Mic className="w-4 h-4" strokeWidth={1.75} />
            Reply in your words
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="px-1 pb-1">
      {waiting && (
        <div className="flex items-center gap-2 pb-2 text-meta font-medium text-st-waiting tnum">
          <StateGlyph state="waiting" size={12} />
          {waiting}
        </div>
      )}
      {prompt.question && <p className="pb-3 text-title font-semibold text-fg-1">{prompt.question}</p>}
      <div className="flex flex-col gap-1.5">
        {prompt.options.map((o, i) => (
          <button
            key={o.key}
            type="button"
            className={`pl-qopt${i === 0 ? ' first' : ''}`}
            onClick={() => { close(); onAnswer(o); }}
          >
            {o.label}
          </button>
        ))}
        <button type="button" className="pl-qopt ghost" onClick={() => { close(); onReply(); }}>
          <Mic className="w-4 h-4 text-fg-3" strokeWidth={1.75} />
          Reply in your words
        </button>
      </div>
      <p className="pt-3 text-meta text-fg-3">One tap answers. It reaches {name} exactly as if you pressed that key.</p>
    </div>
  );
}

/** Desktop: the copy list as a dropdown inside a pane. */
export function ClaudeReplyPanel({ state, onClose }: {
  state: ClaudeReplyState;
  onClose: () => void;
  /** Kept for callers; panes are the only place this renders now. */
  variant?: 'pane';
}) {
  const { copied, copy } = useCopy();
  return (
    <div
      className="absolute inset-x-2 top-2 z-20 max-h-[75%] overflow-y-auto bg-bg-2 border border-line-2 rounded-[10px] shadow-(--e-2-shadow) motion-safe:animate-pop"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sticky top-0 z-10 bg-bg-2 flex items-center justify-between gap-2 px-3 pt-2 pb-1.5 border-b border-line">
        <span className="text-meta font-semibold text-fg-2">Copy from Claude</span>
        <div className="flex items-center gap-1">
          {typeof state === 'object' && state.found && (
            <button type="button" onClick={() => copy('reply', state.text)} className="pl-btn sm ghost" title="Copy the whole reply as markdown">
              <CopyMark done={copied === 'reply'} />
              Whole reply
            </button>
          )}
          <button type="button" onClick={onClose} className="pl-btn sm ghost">Close</button>
        </div>
      </div>
      <div className="px-2 py-2">
        <CopyList state={state} copied={copied} copy={copy} />
      </div>
    </div>
  );
}
