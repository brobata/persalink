/**
 * @file Web Speech API voice-to-text hook
 * @description Wraps `SpeechRecognition` (Chrome/Edge/Safari) and pipes final
 *   transcripts to a caller-provided handler. Requires a secure context
 *   (https/localhost) — falls back to `isSupported = false` otherwise.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
type SpeechRecognitionErrorEventLike = { error: string; message?: string };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// The silence auto-stop only earns its keep where leaving the mic open is
// costly: phones (battery drain + holding the screen wake lock). On a desktop
// the mic is manually toggled and there's no battery/wake-lock pressure, so the
// auto-stop is pure downside there — and actively harmful. Its kill-timer can
// only be held off by a "still speaking" signal, but with interimResults
// disabled (to avoid Android laddering, see below) the only such signals are
// speechstart/speechend, which desktop Chrome fires late and unreliably. The
// timer then counts down against live speech and calls stop() mid-sentence. So
// gate the auto-stop to touch devices; on desktop, recognition stays open until
// the user stops it (or Chrome ends it on its own and we transparently restart).
const AUTO_STOP_ON_SILENCE = (() => {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
  } catch { return false; }
})();

// Only one recognizer may hold the mic at a time. Chrome lets a second
// SpeechRecognition start by aborting the first; the first's onend then
// auto-restarts (its user still wants to listen), which aborts the second,
// whose onend restarts it... an endless ping-pong that freezes the app. So
// starting dictation in any pane first hard-stops whichever pane has the mic.
let activeMic: { abandon: () => void } | null = null;

export type VoiceInputState = {
  isSupported: boolean;
  isListening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
};

export function useVoiceInput(onFinalTranscript: (text: string) => void): VoiceInputState {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Hold the latest handler in a ref so callbacks always see the current
  // closure without re-instantiating recognition on every parent render.
  const handlerRef = useRef(onFinalTranscript);
  handlerRef.current = onFinalTranscript;
  // Track intent vs. browser-driven `onend` (Chrome auto-ends after silence).
  // If the user is still in "listening" mode we restart automatically.
  const wantListeningRef = useRef(false);
  // Screen Wake Lock held while recording. Without it the phone screen times
  // out mid-dictation, which kills SpeechRecognition (losing the in-flight
  // utterance) and wedges the mic button until the user backs out and reopens
  // the session. Holding the lock keeps the screen on so that never happens.
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const acquireWakeLock = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        const lock = await navigator.wakeLock.request('screen');
        // Stopped (or another pane took the mic) while the request was pending.
        if (!wantListeningRef.current) { void lock.release(); return; }
        wakeLockRef.current = lock;
      }
    } catch { /* unsupported / denied — dictation still works, just no keep-awake */ }
  }, []);

  const releaseWakeLock = useCallback(() => {
    try { wakeLockRef.current?.release(); } catch { /* ignore */ }
    wakeLockRef.current = null;
  }, []);

  // Auto-stop after a stretch of silence so the mic doesn't sit open (and drain
  // battery / hold the wake lock) when you've stopped talking. TOUCH DEVICES
  // ONLY — see AUTO_STOP_ON_SILENCE above; on desktop this timer is never armed
  // because its speech-boundary heartbeat is unreliable and it cuts off live
  // speech. Kept generous (15s) so a mid-sentence "thinking" pause on a phone
  // doesn't trip it.
  const SILENCE_MS = 15000;
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRef = useRef<() => void>(() => {});
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  }, []);
  const armSilenceTimer = useCallback(() => {
    if (!AUTO_STOP_ON_SILENCE) return; // desktop: never auto-stop (would cut live speech)
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => stopRef.current(), SILENCE_MS);
  }, [clearSilenceTimer]);

  // Kill switch: `localStorage.persalink_voice = 'off'` fully disables voice
  // (no SpeechRecognition instance, no listeners, button hidden). Reload the
  // app after toggling. Default is on when the browser supports it.
  const killed = (() => {
    try { return typeof window !== 'undefined' && localStorage.getItem('persalink_voice') === 'off'; }
    catch { return false; }
  })();
  // Tear down immediately, without waiting for onend: used when another pane
  // takes the mic and when the page is hidden. recognitionRef is cleared BEFORE
  // abort so the late onend sees a stale instance and neither restarts nor
  // clobbers state.
  const abandon = useCallback(() => {
    wantListeningRef.current = false;
    clearSilenceTimer();
    releaseWakeLock();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    setIsListening(false);
    if (rec) {
      try { rec.abort(); } catch { /* ignore */ }
    }
  }, [releaseWakeLock, clearSilenceTimer]);
  // Stable identity for the module-level activeMic slot; `abandon` kept current.
  const ownerRef = useRef({ abandon });
  ownerRef.current.abandon = abandon;
  const releaseOwnership = () => {
    if (activeMic === ownerRef.current) activeMic = null;
  };

  const isSupported = !killed && getCtor() !== null && (typeof window === 'undefined' || window.isSecureContext);

  const start = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) {
      setError('Speech recognition not supported in this browser');
      return;
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setError('Voice input requires HTTPS');
      return;
    }
    if (recognitionRef.current) return;
    if (activeMic && activeMic !== ownerRef.current) activeMic.abandon();
    activeMic = ownerRef.current;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = true;
    // Finals only — interim results on Android can make the engine emit
    // cumulative phrases that ladder ("can you / can you check / ..."). The
    // silence auto-stop is driven by speech-boundary events instead: clear the
    // timer while talking, arm it when speech stops.
    rec.interimResults = false;
    rec.onspeechstart = () => clearSilenceTimer();
    rec.onspeechend = () => armSilenceTimer();
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) handlerRef.current(text + ' ');
        }
      }
      // Re-arm after a recognized segment in case onspeechend doesn't fire.
      armSilenceTimer();
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Microphone permission denied');
        wantListeningRef.current = false;
      } else {
        setError(e.error);
      }
    };
    rec.onend = () => {
      // Abandoned (another pane took the mic, or the page was hidden) — it's
      // already torn down; restarting here is exactly the ping-pong to avoid.
      if (recognitionRef.current !== rec) return;
      if (wantListeningRef.current) {
        try { rec.start(); } catch { /* restart raced with stop */ }
      } else {
        recognitionRef.current = null;
        setIsListening(false);
        releaseWakeLock();
        releaseOwnership();
      }
    };
    recognitionRef.current = rec;
    wantListeningRef.current = true;
    setError(null);
    try {
      rec.start();
      setIsListening(true);
      void acquireWakeLock();
      // Start the silence countdown — if you never say anything, it stops itself.
      armSilenceTimer();
    } catch (err) {
      recognitionRef.current = null;
      wantListeningRef.current = false;
      setIsListening(false);
      releaseWakeLock();
      clearSilenceTimer();
      releaseOwnership();
      setError(err instanceof Error ? err.message : 'Failed to start');
    }
  }, [acquireWakeLock, releaseWakeLock, armSilenceTimer, clearSilenceTimer]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    clearSilenceTimer();
    releaseWakeLock();
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch { /* already stopped */ }
    }
  }, [releaseWakeLock, clearSilenceTimer]);
  // Keep stopRef current so the silence timer (armed before `stop` exists in
  // closure scope) always calls the latest stop.
  stopRef.current = stop;

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  // If the app is backgrounded / screen actually goes off while listening, the
  // OS kills recognition and the wake lock auto-releases. Tear down cleanly so
  // the mic button works again on return WITHOUT the user having to back out of
  // and reopen the session.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && recognitionRef.current) {
        abandon();
        releaseOwnership();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [abandon]);

  useEffect(() => {
    const owner = ownerRef.current;
    return () => {
      wantListeningRef.current = false;
      clearSilenceTimer();
      releaseWakeLock();
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      if (rec) {
        try { rec.abort(); } catch { /* ignore */ }
      }
      if (activeMic === owner) activeMic = null;
    };
  }, [releaseWakeLock, clearSilenceTimer]);

  return { isSupported, isListening, error, start, stop, toggle };
}
