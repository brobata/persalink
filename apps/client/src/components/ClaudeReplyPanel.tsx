/**
 * @file ClaudeReplyPanel
 * @description "Copy from Claude": Claude's last reply and each of its code
 *   blocks, copied from Claude Code's transcript instead of the terminal. The
 *   terminal shows replies hard-wrapped with a gutter, so copying a config or
 *   a long command off the screen drags indentation and line breaks along;
 *   the transcript has the raw markdown. Rendered as an in-pane dropdown on
 *   desktop and a bottom sheet on mobile.
 */

import { useState } from 'react';
import type { ClaudeReplyState } from '../stores/appStore';
import { copyTextToClipboard } from '../lib/clipboardBridge';
import { useAppStore } from '../stores/appStore';

const PREVIEW_LINES = 6;

function CopyIcon({ done }: { done: boolean }) {
  return done ? (
    <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  ) : (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  );
}

export function ClaudeReplyPanel({ state, onClose, variant }: {
  state: ClaudeReplyState;
  onClose: () => void;
  variant: 'pane' | 'sheet';
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (key: string, text: string) => {
    if (await copyTextToClipboard(text)) {
      setCopied(key);
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1200);
    } else {
      useAppStore.getState().pushNotification('error', 'Copy blocked by browser', 'copy');
    }
  };

  const touch = variant === 'sheet';
  const body = (
    <>
      <div className={`sticky top-0 bg-zinc-900 flex items-center justify-between border-b border-zinc-800 ${
        touch ? 'px-4 pt-3 pb-2' : 'px-3 pt-2 pb-1.5 rounded-t-lg'
      }`}>
        <span className={touch ? 'text-sm font-semibold text-zinc-300' : 'text-[11px] font-semibold text-zinc-400'}>
          Copy from Claude
        </span>
        <div className="flex items-center gap-1">
          {typeof state === 'object' && state.found && (
            <button
              onClick={() => copy('reply', state.text)}
              className={`flex items-center gap-1.5 rounded transition-colors text-zinc-300 hover:bg-zinc-800 ${
                touch ? 'px-3 py-1.5 text-sm' : 'px-2 py-0.5 text-[11px]'
              }`}
              title="Copy the whole reply as markdown"
            >
              <CopyIcon done={copied === 'reply'} />
              Whole reply
            </button>
          )}
          <button onClick={onClose} className={touch ? 'px-2 py-1 text-zinc-500 text-sm' : 'px-1.5 text-zinc-600 hover:text-zinc-300 text-xs'}>
            {touch ? 'Close' : '×'}
          </button>
        </div>
      </div>
      <div className={touch ? 'px-3 py-2 pb-[max(12px,env(safe-area-inset-bottom))]' : 'px-2 py-1.5'}>
        {state === 'loading' && (
          <div className="px-2 py-4 text-center text-xs text-zinc-600">Reading Claude&apos;s last reply…</div>
        )}
        {typeof state === 'object' && !state.found && (
          <div className="px-2 py-4 text-center text-xs text-zinc-500">{state.reason}</div>
        )}
        {typeof state === 'object' && state.found && state.blocks.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-500">
            No code blocks in the last reply — use <span className="text-zinc-300">Whole reply</span> to copy it.
          </div>
        )}
        {typeof state === 'object' && state.found && state.blocks.map((block, i) => {
          const lines = block.code.split('\n');
          const key = `block-${i}`;
          return (
            <button
              key={key}
              onClick={() => copy(key, block.code)}
              className="group w-full text-left mb-1.5 rounded-md border border-zinc-800 hover:border-zinc-600 bg-zinc-950/60 transition-colors"
              title="Copy this block"
            >
              <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-800/80">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                  {block.lang || 'code'} · {lines.length} line{lines.length === 1 ? '' : 's'}
                </span>
                <span className="flex items-center gap-1 text-[11px] text-zinc-500 group-hover:text-zinc-200">
                  <CopyIcon done={copied === key} />
                  {copied === key ? 'Copied' : 'Copy'}
                </span>
              </div>
              <pre className="px-2 py-1.5 text-[11px] leading-snug text-zinc-300 font-mono whitespace-pre overflow-hidden">
                {lines.slice(0, PREVIEW_LINES).join('\n')}
                {lines.length > PREVIEW_LINES && <span className="text-zinc-600">{`\n… ${lines.length - PREVIEW_LINES} more`}</span>}
              </pre>
            </button>
          );
        })}
      </div>
    </>
  );

  if (variant === 'sheet') {
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
        <div
          className="w-full max-h-[75vh] bg-zinc-900 border-t border-zinc-700 rounded-t-2xl overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      </div>
    );
  }
  return (
    <div
      className="absolute inset-x-2 top-2 z-20 max-h-[75%] overflow-y-auto bg-zinc-900/95 border border-zinc-700 rounded-lg shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </div>
  );
}
