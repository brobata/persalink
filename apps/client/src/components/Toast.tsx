import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { COPY_PENDING_OP, completePendingCopy } from '../lib/clipboardBridge';
import { SHARE_PENDING_OP, consumePendingShare } from '../lib/shareTarget';

const AUTO_DISMISS_MS = 5_000;
// Tap-to-act toasts (finish a copy, insert shared text) get longer — the
// user has to notice AND reach them.
const TAP_ACTION_DISMISS_MS = 12_000;

export function ToastStack() {
  const notifications = useAppStore((s) => s.notifications);
  const dismiss = useAppStore((s) => s.dismissNotification);

  useEffect(() => {
    if (notifications.length === 0) return;
    const timers = notifications.map((n) => {
      const ttl = n.op === COPY_PENDING_OP || n.op === SHARE_PENDING_OP ? TAP_ACTION_DISMISS_MS : AUTO_DISMISS_MS;
      const remaining = Math.max(0, ttl - (Date.now() - n.createdAt));
      return setTimeout(() => dismiss(n.id), remaining);
    });
    return () => timers.forEach(clearTimeout);
  }, [notifications, dismiss]);

  if (notifications.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`pointer-events-auto w-full max-w-md rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-sm ${
            n.kind === 'error'
              ? 'bg-red-950/90 border-red-900/60 text-red-100'
              : 'bg-zinc-900/90 border-zinc-700 text-zinc-100'
          }`}
        >
          <div className="flex items-start gap-3">
            {n.op === COPY_PENDING_OP ? (
              // Tap-to-finish copy: the tap IS the user gesture Android wants.
              <button
                onClick={() => { void completePendingCopy(); dismiss(n.id); }}
                className="flex-1 min-w-0 text-left"
              >
                <div className="text-[11px] font-mono uppercase tracking-wider text-emerald-400 mb-0.5">copy</div>
                <div className="break-words">{n.message}</div>
              </button>
            ) : n.op === SHARE_PENDING_OP ? (
              // Share-sheet intake: the tap is the user's consent to type the
              // shared text into the attached session.
              <button
                onClick={() => {
                  const text = consumePendingShare();
                  if (text) useAppStore.getState().sendInput(text);
                  dismiss(n.id);
                }}
                className="flex-1 min-w-0 text-left"
              >
                <div className="text-[11px] font-mono uppercase tracking-wider text-emerald-400 mb-0.5">share</div>
                <div className="break-words">{n.message}</div>
              </button>
            ) : (
              <div className="flex-1 min-w-0">
                {n.op && (
                  <div className="text-[11px] font-mono uppercase tracking-wider opacity-60 mb-0.5">{n.op}</div>
                )}
                <div className="break-words">{n.message}</div>
              </div>
            )}
            <button
              onClick={() => dismiss(n.id)}
              className="shrink-0 -mr-1 -mt-1 px-2 py-1 opacity-50 hover:opacity-100 active:opacity-100 transition-opacity"
              title="Dismiss"
            >
              &times;
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
