/**
 * @file TerminalSettings
 * @description Popover UI for adjusting xterm font and color theme. Lives
 *   behind the gear button in the GridLayout top bar. Changes apply live to
 *   every mounted TerminalPane via the terminalStyleStore.
 */

import { useEffect, useRef } from 'react';
import {
  useTerminalStyleStore, FONT_FAMILIES, THEMES, HISTORY_OPTIONS,
  type FontFamilyChoice, type FontWeightChoice, type ThemeName, type HistoryOnAttach,
} from '../stores/terminalStyleStore';

interface TerminalSettingsProps {
  onClose: () => void;
  /** 'popover' anchors under the grid gear (desktop); 'sheet' renders as a
   *  mobile bottom sheet — same controls, different shell. */
  variant?: 'popover' | 'sheet';
}

export function TerminalSettings({ onClose, variant = 'popover' }: TerminalSettingsProps) {
  const style = useTerminalStyleStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={variant === 'sheet'
        ? 'fixed inset-x-0 bottom-0 z-50 max-h-[75vh] overflow-y-auto bg-zinc-900 border-t border-zinc-700 rounded-t-2xl shadow-2xl p-4 pb-[max(16px,env(safe-area-inset-bottom))] space-y-3'
        : 'absolute top-full right-0 mt-1 z-50 w-[300px] bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl p-3 space-y-3'}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-200">Terminal appearance</span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => style.reset()}
            className="text-[10px] text-zinc-500 hover:text-zinc-300"
            title="Reset to defaults"
          >
            reset
          </button>
          {variant === 'sheet' && (
            <button onClick={onClose} className="text-xs text-zinc-500 active:text-zinc-300">Close</button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider text-zinc-500">Font</label>
        <select
          value={style.fontFamily}
          onChange={(e) => style.setFontFamily(e.target.value as FontFamilyChoice)}
          className="w-full px-2 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 outline-none focus:border-zinc-500"
        >
          {(Object.entries(FONT_FAMILIES) as [FontFamilyChoice, { label: string }][]).map(
            ([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            )
          )}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500">Weight</label>
          <select
            value={style.fontWeight}
            onChange={(e) => style.setFontWeight(e.target.value as FontWeightChoice)}
            className="w-full px-2 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 outline-none focus:border-zinc-500"
          >
            <option value="300">Light</option>
            <option value="400">Regular</option>
            <option value="500">Medium</option>
            <option value="600">Semibold</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500">Size</label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={10}
              max={20}
              step={1}
              value={style.fontSize}
              onChange={(e) => style.setFontSize(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-xs text-zinc-400 w-6 text-right">{style.fontSize}</span>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider text-zinc-500">History on attach</label>
        <select
          value={style.historyOnAttach}
          onChange={(e) => style.setHistoryOnAttach(Number(e.target.value) as HistoryOnAttach)}
          className="w-full px-2 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 outline-none focus:border-zinc-500"
        >
          {HISTORY_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'None (live only)' : `${n.toLocaleString()} lines`}
            </option>
          ))}
        </select>
        <p className="text-[10px] text-zinc-600 leading-snug">
          Lines of tmux history pulled when reattaching to a session.
          Higher = more context after a refresh; 0 = fastest (live output only).
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500">Color theme</label>
          <span className="text-[10px] text-zinc-400">{THEMES[style.theme]?.label}</span>
        </div>
        {/* Swatch grid — bg chip + accent dots per theme, name on hover/press.
            Scales to the full theme pack where a select + strip couldn't. */}
        <div className="grid grid-cols-4 gap-1.5">
          {(Object.entries(THEMES) as [ThemeName, { label: string; theme: { background: string; foreground: string; green: string; blue: string; magenta: string } }][]).map(
            ([key, { label, theme }]) => (
              <button
                key={key}
                onClick={() => style.setTheme(key)}
                className={`h-9 rounded-md border transition-colors ${
                  style.theme === key ? 'border-zinc-200 ring-1 ring-zinc-200' : 'border-zinc-700 hover:border-zinc-500'
                }`}
                style={{ backgroundColor: theme.background }}
                title={label}
                aria-label={label}
              >
                <div className="flex items-center justify-center gap-[3px] h-full">
                  <span style={{ backgroundColor: theme.foreground }} className="w-1.5 h-1.5 rounded-full" />
                  <span style={{ backgroundColor: theme.green }} className="w-1.5 h-1.5 rounded-full" />
                  <span style={{ backgroundColor: theme.blue }} className="w-1.5 h-1.5 rounded-full" />
                  <span style={{ backgroundColor: theme.magenta }} className="w-1.5 h-1.5 rounded-full" />
                </div>
              </button>
            )
          )}
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <div>
          <label htmlFor="double-tap-tab" className="text-xs text-zinc-300">Double-tap sends Tab</label>
          <p className="text-[10px] text-zinc-600 leading-snug">Completion shortcut. Turn off if Tab misfires in your TUIs.</p>
        </div>
        <input
          id="double-tap-tab"
          type="checkbox"
          checked={style.doubleTapTab}
          onChange={(e) => style.setDoubleTapTab(e.target.checked)}
          className="w-4 h-4 rounded bg-zinc-800 border-zinc-600 shrink-0 ml-3"
        />
      </div>

      <div className="flex items-center justify-between pt-1">
        <div>
          <label htmlFor="input-debug" className="text-xs text-zinc-300">Input debug overlay</label>
          <p className="text-[10px] text-zinc-600 leading-snug">Show raw key/wheel/touch events in the terminal — for diagnosing exotic keyboards.</p>
        </div>
        <input
          id="input-debug"
          type="checkbox"
          checked={style.inputDebug}
          onChange={(e) => style.setInputDebug(e.target.checked)}
          className="w-4 h-4 rounded bg-zinc-800 border-zinc-600 shrink-0 ml-3"
        />
      </div>
    </div>
  );
}
