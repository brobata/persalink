/**
 * @file SnippetSheet
 * @description Bottom sheet for the global snippet library. Tap a snippet to
 *   insert it into the current session (after prompting for {{variables}});
 *   run it detached on this server; or fan it out across every server in the
 *   registry (active server over the live socket, others via throwaway
 *   sockets — see lib/remoteServer). Editing/creating lives in the same sheet.
 */

import { useMemo, useState } from 'react';
import { useAppStore, type ServerEntry } from '../stores/appStore';
import { remoteExec } from '../lib/remoteServer';
import type { Snippet } from '@persalink/shared/protocol';

const VAR_RX = /\{\{([a-zA-Z0-9_ -]+)\}\}/g;

function parseVars(command: string): string[] {
  const names = new Set<string>();
  for (const m of command.matchAll(VAR_RX)) names.add(m[1]);
  return [...names];
}

function render(command: string, values: Record<string, string>): string {
  return command.replace(VAR_RX, (_, name: string) => values[name] ?? '');
}

interface TargetResult {
  label: string;
  status: 'running' | 'done' | 'failed';
  output: string;
  exitCode: number | null;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'edit'; snippet: Partial<Snippet> }
  | { kind: 'vars'; snippet: Snippet; next: 'insert' | 'run' | 'multi' }
  | { kind: 'targets'; snippet: Snippet; values: Record<string, string> }
  | { kind: 'results'; title: string; results: TargetResult[] };

let execCounter = 0;

export function SnippetSheet({ onClose, sendInput }: {
  onClose: () => void;
  sendInput: (data: string) => void;
}) {
  const snippets = useAppStore((s) => s.snippets);
  const servers = useAppStore((s) => s.servers);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const execResults = useAppStore((s) => s.execResults);
  const { saveSnippet, deleteSnippet, execCommand, clearExecResult, pushNotification } = useAppStore();

  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [pickedServers, setPickedServers] = useState<Set<string>>(new Set());
  // Local exec bookkeeping: active-server runs land in the store keyed by tag;
  // remote runs resolve their promises straight into local state.
  const [localResults, setLocalResults] = useState<TargetResult[]>([]);
  const [activeTags, setActiveTags] = useState<Array<{ label: string; tag: string }>>([]);

  const activeEntry = servers.find((e) => e.id === activeServerId) ?? null;

  const mergedResults: TargetResult[] = useMemo(() => {
    const fromTags: TargetResult[] = activeTags.map(({ label, tag }) => {
      const r = execResults[tag];
      if (!r) return { label, status: 'running', output: '', exitCode: null };
      return { label, status: r.spawnError || r.exitCode !== 0 ? 'failed' : 'done', output: r.output, exitCode: r.exitCode };
    });
    return [...fromTags, ...localResults];
  }, [activeTags, execResults, localResults]);

  const startAction = (snippet: Snippet, next: 'insert' | 'run' | 'multi') => {
    setVarValues({});
    if (parseVars(snippet.command).length > 0) {
      setMode({ kind: 'vars', snippet, next });
    } else {
      proceed(snippet, {}, next);
    }
  };

  const proceed = (snippet: Snippet, values: Record<string, string>, next: 'insert' | 'run' | 'multi') => {
    const command = render(snippet.command, values);
    if (next === 'insert') {
      sendInput(command);
      onClose();
      return;
    }
    if (next === 'run') {
      const tag = `snip-${++execCounter}-${snippet.id}`;
      setActiveTags([{ label: activeEntry?.serverName || activeEntry?.label || 'This server', tag }]);
      setLocalResults([]);
      execCommand(command, tag);
      setMode({ kind: 'results', title: snippet.name, results: [] });
      return;
    }
    // multi → pick servers first
    setPickedServers(new Set(servers.map((e) => e.id)));
    setMode({ kind: 'targets', snippet, values });
  };

  const runMulti = (snippet: Snippet, values: Record<string, string>) => {
    const command = render(snippet.command, values);
    const tags: Array<{ label: string; tag: string }> = [];
    const locals: TargetResult[] = [];
    for (const entry of servers) {
      if (!pickedServers.has(entry.id)) continue;
      const label = entry.serverName || entry.label;
      if (entry.id === activeServerId) {
        const tag = `snip-${++execCounter}-${snippet.id}`;
        tags.push({ label, tag });
        execCommand(command, tag);
      } else {
        locals.push({ label, status: 'running', output: '', exitCode: null });
        remoteExec(entry, command).then(
          (r) => setLocalResults((prev) => prev.map((x) => x.label === label
            ? { label, status: r.exitCode === 0 ? 'done' : 'failed', output: r.output, exitCode: r.exitCode }
            : x)),
          (err: Error) => setLocalResults((prev) => prev.map((x) => x.label === label
            ? { label, status: 'failed', output: err.message === 'no-token' ? 'No saved login — connect to this server once first.' : `Unreachable (${err.message})`, exitCode: null }
            : x)),
        );
      }
    }
    setActiveTags(tags);
    setLocalResults(locals);
    setMode({ kind: 'results', title: snippet.name, results: [] });
  };

  const closeResults = () => {
    for (const { tag } of activeTags) clearExecResult(tag);
    setActiveTags([]);
    setLocalResults([]);
    setMode({ kind: 'list' });
  };

  const handleSaveEdit = (draft: Partial<Snippet>) => {
    const name = draft.name?.trim();
    const command = draft.command?.trim();
    if (!name || !command) {
      pushNotification('error', 'Snippet needs a name and a command.', 'snippet');
      return;
    }
    const id = draft.id || name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `snip-${Date.now() % 1e8}`;
    saveSnippet({ id, name, command });
    setMode({ kind: 'list' });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-h-[75vh] bg-zinc-900 border-t border-zinc-700 rounded-t-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-zinc-900 px-4 pt-3 pb-2 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-300">
            {mode.kind === 'edit' ? (mode.snippet.id ? 'Edit snippet' : 'New snippet')
              : mode.kind === 'vars' ? 'Fill in variables'
              : mode.kind === 'targets' ? 'Run on which servers?'
              : mode.kind === 'results' ? `Results — ${mode.title}`
              : 'Snippets'}
          </span>
          <div className="flex items-center gap-3">
            {mode.kind === 'list' && (
              <button
                onClick={() => setMode({ kind: 'edit', snippet: {} })}
                className="text-xs text-emerald-400 active:text-emerald-300"
              >
                + New
              </button>
            )}
            <button
              onClick={() => (mode.kind === 'results' ? closeResults() : mode.kind === 'list' ? onClose() : setMode({ kind: 'list' }))}
              className="px-2 py-1 text-zinc-500 text-sm"
            >
              {mode.kind === 'list' ? 'Close' : mode.kind === 'results' ? 'Done' : 'Back'}
            </button>
          </div>
        </div>

        <div className="px-3 py-3 pb-[max(16px,env(safe-area-inset-bottom))] space-y-2">
          {mode.kind === 'list' && (
            <>
              {snippets.length === 0 && (
                <p className="px-3 py-8 text-center text-sm text-zinc-600">
                  No snippets yet. Save the commands you keep retyping — use{' '}
                  <span className="font-mono text-zinc-500">{'{{variable}}'}</span> for fill-in-the-blank parts.
                </p>
              )}
              {snippets.map((s) => (
                <div key={s.id} className="flex items-center rounded-xl bg-zinc-800/60">
                  <button
                    onClick={() => startAction(s, 'insert')}
                    className="flex-1 min-w-0 px-3.5 py-3 text-left active:bg-zinc-800 rounded-l-xl"
                    title="Insert into current session"
                  >
                    <div className="text-sm font-medium text-zinc-100 truncate">{s.name}</div>
                    <div className="text-[11px] text-zinc-500 font-mono truncate">{s.command}</div>
                  </button>
                  <button
                    onClick={() => startAction(s, 'run')}
                    className="shrink-0 px-2.5 py-3 text-zinc-500 active:text-emerald-400"
                    title="Run on this server (detached)"
                  >
                    ▶
                  </button>
                  {servers.length > 1 && (
                    <button
                      onClick={() => startAction(s, 'multi')}
                      className="shrink-0 px-2.5 py-3 text-zinc-500 active:text-sky-400"
                      title="Run on multiple servers"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <rect x="2" y="3" width="20" height="6" rx="1.5" />
                        <rect x="2" y="15" width="20" height="6" rx="1.5" />
                        <circle cx="6" cy="6" r=".5" fill="currentColor" /><circle cx="6" cy="18" r=".5" fill="currentColor" />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={() => setMode({ kind: 'edit', snippet: s })}
                    className="shrink-0 px-2.5 py-3 text-zinc-600 active:text-zinc-300 rounded-r-xl"
                    title="Edit snippet"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                </div>
              ))}
            </>
          )}

          {mode.kind === 'edit' && (
            <EditForm
              initial={mode.snippet}
              onSave={handleSaveEdit}
              onDelete={mode.snippet.id ? () => { deleteSnippet(mode.snippet.id!); setMode({ kind: 'list' }); } : undefined}
            />
          )}

          {mode.kind === 'vars' && (
            <div className="space-y-3">
              <p className="text-[11px] text-zinc-600 font-mono px-1">{mode.snippet.command}</p>
              {parseVars(mode.snippet.command).map((name) => (
                <div key={name}>
                  <label className="block text-sm text-zinc-400 mb-1">{name}</label>
                  <input
                    value={varValues[name] ?? ''}
                    onChange={(e) => setVarValues((v) => ({ ...v, [name]: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm font-mono text-zinc-100 outline-none focus:border-zinc-500"
                    autoFocus={name === parseVars(mode.snippet.command)[0]}
                  />
                </div>
              ))}
              <button
                onClick={() => proceed(mode.snippet, varValues, mode.next)}
                className="w-full py-2.5 bg-zinc-100 text-zinc-900 text-sm font-semibold rounded-lg active:bg-zinc-300"
              >
                {mode.next === 'insert' ? 'Insert' : 'Run'}
              </button>
            </div>
          )}

          {mode.kind === 'targets' && (
            <div className="space-y-2">
              {servers.map((e: ServerEntry) => (
                <label key={e.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-800/60">
                  <input
                    type="checkbox"
                    checked={pickedServers.has(e.id)}
                    onChange={(ev) => setPickedServers((prev) => {
                      const next = new Set(prev);
                      if (ev.target.checked) next.add(e.id); else next.delete(e.id);
                      return next;
                    })}
                    className="w-4 h-4 rounded bg-zinc-800 border-zinc-600"
                  />
                  <span className="flex-1 text-sm text-zinc-200">{e.serverName || e.label}</span>
                  {e.id === activeServerId && <span className="text-[10px] text-zinc-500">active</span>}
                </label>
              ))}
              <button
                onClick={() => runMulti(mode.snippet, mode.values)}
                disabled={pickedServers.size === 0}
                className="w-full py-2.5 bg-zinc-100 text-zinc-900 text-sm font-semibold rounded-lg active:bg-zinc-300 disabled:opacity-40"
              >
                Run on {pickedServers.size} server{pickedServers.size === 1 ? '' : 's'}
              </button>
            </div>
          )}

          {mode.kind === 'results' && (
            <div className="space-y-2">
              {mergedResults.map((r) => (
                <div key={r.label} className="rounded-xl bg-zinc-800/60 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
                    <span className="flex-1 text-sm font-medium text-zinc-200">{r.label}</span>
                    {r.status === 'running' && <span className="w-3.5 h-3.5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />}
                    {r.status === 'done' && <span className="text-[10px] text-emerald-400">exit {r.exitCode}</span>}
                    {r.status === 'failed' && <span className="text-[10px] text-red-400">{r.exitCode === null ? 'error' : `exit ${r.exitCode}`}</span>}
                  </div>
                  {r.output && (
                    <pre className="px-3 py-2 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{r.output.trim()}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EditForm({ initial, onSave, onDelete }: {
  initial: Partial<Snippet>;
  onSave: (draft: Partial<Snippet>) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial.name ?? '');
  const [command, setCommand] = useState(initial.command ?? '');
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm text-zinc-400 mb-1">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Restart caterops"
          className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
          autoFocus
        />
      </div>
      <div>
        <label className="block text-sm text-zinc-400 mb-1">Command</label>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="pm2 restart {{app}}"
          className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm font-mono text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
        />
        <p className="text-[11px] text-zinc-600 mt-1">
          <span className="font-mono">{'{{variable}}'}</span> parts are prompted when you use the snippet.
        </p>
      </div>
      <button
        onClick={() => onSave({ ...initial, name, command })}
        className="w-full py-2.5 bg-zinc-100 text-zinc-900 text-sm font-semibold rounded-lg active:bg-zinc-300"
      >
        Save snippet
      </button>
      {onDelete && (
        <button onClick={onDelete} className="w-full py-2 text-xs text-red-400/70 active:text-red-400">
          Delete snippet
        </button>
      )}
    </div>
  );
}
