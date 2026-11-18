/**
 * @file Inline answers (sending)
 * @description Reads a waiting agent's question and types its answer from
 *   Home, over the server's existing `exec.run` (see lib/inlineAnswer for
 *   the commands and why no attach is used). `useWaitingPrompt` peeks once
 *   per change of a waiting session's preview and caches the result for
 *   every card that shows it. `sendInlineAnswer` reads the screen again
 *   right before typing and sends nothing if the question changed, so a
 *   stale card can never answer a different prompt.
 */

import { useEffect, useState } from 'react';
import type { SessionInfo } from '@persalink/shared/protocol';
import { useAppStore } from '../stores/appStore';
import { chipLabel, type ClaudePrompt, type PromptOption } from './claudePrompt';
import { answeredBook } from './answered';
import { captureCommand, confirmOption, peekKey, promptFromCapture, sendKeyCommand } from './inlineAnswer';
import { stateKey } from './sessionState';

const EXEC_TIMEOUT_MS = 6000;
let seq = 0;

/** Run one command through exec.run and resolve with its result (null on timeout or no link). */
function runExec(command: string): Promise<{ output: string; exitCode: number } | null> {
  const app = useAppStore.getState();
  if (app.connectionState !== 'authenticated') return Promise.resolve(null);
  const tag = `inline-${Date.now().toString(36)}-${(seq++).toString(36)}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { output: string; exitCode: number } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      useAppStore.getState().clearExecResult(tag);
      resolve(v);
    };
    const unsub = useAppStore.subscribe((s) => {
      const r = s.execResults[tag];
      if (r) finish({ output: r.output, exitCode: r.exitCode });
    });
    const timer = setTimeout(() => finish(null), EXEC_TIMEOUT_MS);
    app.execCommand(command, tag);
  });
}

async function readPrompt(id: string): Promise<ClaudePrompt | null> {
  const cmd = captureCommand(id);
  if (!cmd) return null;
  const r = await runExec(cmd);
  if (!r || r.exitCode !== 0) return null;
  return promptFromCapture(r.output);
}

// One peek per (session, preview, activity); every card showing it shares it.
const cache = new Map<string, ClaudePrompt | null>();
const inflight = new Map<string, Promise<ClaudePrompt | null>>();
// A waiting session that keeps printing must not be read on every tick:
// at most one read per session per PEEK_GAP_MS.
const PEEK_GAP_MS = 4000;
const lastPeek = new Map<string, number>();

function peek(s: SessionInfo): Promise<ClaudePrompt | null> {
  const key = peekKey(s);
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  let p = inflight.get(key);
  if (!p) {
    lastPeek.set(s.id, Date.now());
    p = readPrompt(s.id).then((prompt) => {
      inflight.delete(key);
      cache.set(key, prompt);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
      return prompt;
    });
    inflight.set(key, p);
  }
  return p;
}

/**
 * The question a waiting session is asking, read from its screen. `null`
 * while unknown or when its screen holds no numbered prompt (then the card
 * offers Open instead of answers). Only waiting sessions are read.
 */
export function useWaitingPrompt(s: SessionInfo): { prompt: ClaudePrompt | null; reading: boolean } {
  const waiting = stateKey(s) === 'waiting';
  const key = peekKey(s);
  const linked = useAppStore((st) => st.connectionState === 'authenticated');
  const [state, setState] = useState<{ key: string; prompt: ClaudePrompt | null; reading: boolean }>(() => ({
    key, prompt: cache.get(key) ?? null, reading: waiting && !cache.has(key),
  }));

  useEffect(() => {
    if (!waiting || !linked) return;
    if (cache.has(key)) {
      setState({ key, prompt: cache.get(key)!, reading: false });
      return;
    }
    let live = true;
    // Keep the last answers on screen while the new read is in flight, so a
    // preview tick does not make the chips blink.
    setState((cur) => ({ key, prompt: cur.prompt, reading: true }));
    // A short settle (Claude draws its prompt in a burst of frames), and
    // never sooner than PEEK_GAP_MS after this session's last read.
    const since = Date.now() - (lastPeek.get(s.id) ?? 0);
    const t = setTimeout(() => {
      void peek(s).then((prompt) => { if (live) setState({ key, prompt, reading: false }); });
    }, Math.max(250, PEEK_GAP_MS - since));
    return () => { live = false; clearTimeout(t); };
    // `s` is read only through `key` (its id, preview and activity).
  }, [key, waiting, linked]);

  if (!waiting) return { prompt: null, reading: false };
  return { prompt: state.prompt, reading: state.reading };
}

export type InlineResult = 'sent' | 'changed' | 'failed';

/**
 * Type `option` into session `id`, only if the screen still shows
 * `answered`. 'changed' = the question moved on and nothing was typed;
 * 'failed' = the server could not be asked.
 */
export async function sendInlineAnswer(id: string, answered: ClaudePrompt, option: PromptOption): Promise<InlineResult> {
  const cap = captureCommand(id);
  if (!cap) return 'failed';
  const r = await runExec(cap);
  if (!r) return 'failed';
  if (r.exitCode !== 0) return 'changed';
  const pick = confirmOption(answered, promptFromCapture(r.output), option);
  if (!pick) return 'changed';
  const cmd = sendKeyCommand(id, pick.key);
  if (!cmd) return 'failed';
  const sent = await runExec(cmd);
  if (!sent || sent.exitCode !== 0) return 'failed';
  // Drop the cached question so no card offers it again, and move the agent
  // out of Needs you now: the server cannot see an answer typed this way
  // until something else changes in the session (lib/answered).
  for (const k of cache.keys()) if (k.startsWith(`${id}\u0000`)) cache.delete(k);
  const app = useAppStore.getState();
  const row = app.sessions.find((x) => x.id === id);
  if (row) {
    answeredBook.mark(row, chipLabel(pick));
    useAppStore.setState({ sessions: answeredBook.apply(app.sessions) });
  }
  return 'sent';
}
