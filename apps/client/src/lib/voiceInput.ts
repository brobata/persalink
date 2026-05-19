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

  // Kill switch: `localStorage.persalink_voice = 'off'` fully disables voice
  // (no SpeechRecognition instance, no listeners, button hidden). Reload the
  // app after toggling. Default is on when the browser supports it.
  const killed = (() => {
    try { return typeof window !== 'undefined' && localStorage.getItem('persalink_voice') === 'off'; }
    catch { return false; }
  })();
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
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) handlerRef.current(text + ' ');
        }
      }
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
      if (wantListeningRef.current) {
        try { rec.start(); } catch { /* restart raced with stop */ }
      } else {
        recognitionRef.current = null;
        setIsListening(false);
      }
    };
    recognitionRef.current = rec;
    wantListeningRef.current = true;
    setError(null);
    try {
      rec.start();
      setIsListening(true);
    } catch (err) {
      recognitionRef.current = null;
      wantListeningRef.current = false;
      setIsListening(false);
      setError(err instanceof Error ? err.message : 'Failed to start');
    }
  }, []);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch { /* already stopped */ }
    }
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      const rec = recognitionRef.current;
      if (rec) {
        try { rec.abort(); } catch { /* ignore */ }
        recognitionRef.current = null;
      }
    };
  }, []);

  return { isSupported, isListening, error, start, stop, toggle };
}
