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
}

export function TerminalSettings({ onClose }: TerminalSettingsProps) {
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
      className="absolute top-full right-0 mt-1 z-50 w-[300px] bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl p-3 space-y-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-200">Terminal appearance</span>
        <button
          onClick={() => style.reset()}
          className="text-[10px] text-zinc-500 hover:text-zinc-300"
          title="Reset to defaults"
        >
          reset
        </button>
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
        <label className="text-[10px] uppercase tracking-wider text-zinc-500">Color theme</label>
        <select
          value={style.theme}
          onChange={(e) => style.setTheme(e.target.value as ThemeName)}
          className="w-full px-2 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 outline-none focus:border-zinc-500"
        >
          {(Object.entries(THEMES) as [ThemeName, { label: string }][]).map(
            ([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            )
          )}
        </select>
        <div className="flex gap-1 mt-1.5">
          {(Object.entries(THEMES) as [ThemeName, { theme: { background: string; foreground: string; green: string; blue: string; magenta: string } }][]).map(
            ([key, { theme }]) => (
              <button
                key={key}
                onClick={() => style.setTheme(key)}
                className={`flex-1 h-6 rounded border transition-colors ${
                  style.theme === key ? 'border-zinc-300' : 'border-zinc-700 hover:border-zinc-500'
                }`}
                style={{ backgroundColor: theme.background }}
                title={THEMES[key].label}
              >
                <div className="flex items-center justify-center gap-[2px] h-full">
                  <span style={{ backgroundColor: theme.foreground }} className="w-1 h-1 rounded-full" />
                  <span style={{ backgroundColor: theme.green }} className="w-1 h-1 rounded-full" />
                  <span style={{ backgroundColor: theme.blue }} className="w-1 h-1 rounded-full" />
                  <span style={{ backgroundColor: theme.magenta }} className="w-1 h-1 rounded-full" />
                </div>
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
