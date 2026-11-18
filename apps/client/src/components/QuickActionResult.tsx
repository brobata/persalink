/**
 * @file QuickActionResult
 * @description What a quick action did, after it was run from the command
 *   palette: "Running" until the server's action.result arrives, then the
 *   outcome in one line (Done, Failed with its exit code, Timed out, Could
 *   not start) and the output. Run again and Copy output are the two
 *   actions. Mounted once, in App; shown while uiStore.quickRun is set.
 */

import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useUiStore } from '../stores/uiStore';
import { Sheet } from './ui/Sheet';
import { StateGlyph } from './ui/StateGlyph';

export function QuickActionResult() {
  const run = useUiStore((s) => s.quickRun);
  const setQuickRun = useUiStore((s) => s.setQuickRun);
  const result = useAppStore((s) => s.actionResult);
  const runAction = useAppStore((s) => s.runAction);
  const clearActionResult = useAppStore((s) => s.clearActionResult);
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState(false);
  if (!run) return null;

  const mine = result && result.actionId === run.actionId && (!result.profileId || result.profileId === run.profileId) ? result : null;
  const ok = !!mine && !mine.spawnError && !mine.timedOut && mine.exitCode === 0;
  const status = !mine
    ? 'Running'
    : mine.spawnError ? 'Could not start'
    : mine.timedOut ? 'Timed out'
    : mine.exitCode === 0 ? 'Done' : `Failed · exit ${mine.exitCode}`;

  const close = () => { setQuickRun(null); clearActionResult(); setCopied(false); setArmed(false); };
  const again = () => {
    // An action that asks first asks again: the first press arms, the second runs.
    if (run.confirm && !armed) { setArmed(true); return; }
    setArmed(false);
    setCopied(false);
    setQuickRun({ ...run, startedAt: Date.now() });
    runAction(run.profileId, run.actionId);
  };
  const copy = async () => {
    if (!mine) return;
    try {
      await navigator.clipboard.writeText(mine.output);
      setCopied(true);
    } catch {
      useAppStore.getState().pushNotification('error', 'Could not copy: the clipboard is locked on this page');
    }
  };

  return (
    <Sheet
      title={run.title}
      sub={<span className="font-mono">{run.command}</span>}
      onClose={close}
      contentKey={run.startedAt}
      footer={(
        <div className="flex items-center justify-end gap-2 px-4 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] border-t border-line">
          <button type="button" onClick={copy} disabled={!mine || !mine.output} className="pl-btn">
            {copied ? 'Copied' : 'Copy output'}
          </button>
          <button type="button" onClick={again} disabled={!mine} className="pl-btn pri">
            {armed ? 'Press again to run' : 'Run again'}
          </button>
        </div>
      )}
    >
      <div className="px-2 pb-1">
        <div className="flex items-center gap-2 h-8 text-body" role="status">
          <StateGlyph state={!mine ? 'working' : ok ? 'done' : 'error'} live={!mine} size={14} />
          <span className={ok || !mine ? 'text-fg-1' : 'text-st-error'}>{status}</span>
        </div>
        {mine && (
          mine.output
            ? <pre className="mt-1 max-h-[50dvh] overflow-auto rounded-[6px] bg-bg-0 border border-line p-3 font-mono text-[12px] leading-[18px] text-fg-2 whitespace-pre-wrap break-words">{mine.output}</pre>
            : <p className="mt-1 text-meta text-fg-3">No output.</p>
        )}
        {mine?.truncated && <p className="mt-2 text-meta text-fg-3">The output was cut off at the size limit.</p>}
      </div>
    </Sheet>
  );
}
