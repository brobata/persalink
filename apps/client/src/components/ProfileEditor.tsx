import { useState, useCallback, useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import type { Profile, QuickAction, HealthCheck } from '@persalink/shared/protocol';

// ============================================================================
// Common emoji icons for quick selection
// ============================================================================

const ICON_OPTIONS = [
  '📂', '💻', '🧠', '🚀', '🔧', '🎯', '📋', '🍽️', '👨‍🍳', '💰',
  '📊', '✉️', '📟', '📁', '🔗', '🌐', '🔑', '🐳', '⚡', '🎨',
  '🛠️', '📦', '🧪', '🔍', '📡', '🗄️', '🖥️', '🤖', '🏗️', '💡',
];

const COLOR_PRESETS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#a855f7', '#ec4899', '#6b7280',
];

const BYPASS_FLAG = '--dangerously-skip-permissions';

/** Only `claude ...` commands get the bypass toggle — the flag means nothing
 *  to anything else. */
function isClaudeCommand(command: string): boolean {
  return /^\s*claude\b/.test(command);
}

function hasBypassFlag(command: string): boolean {
  return command.includes(BYPASS_FLAG);
}

/** Add or remove the flag immediately after `claude`, leaving the rest of the
 *  command line (slash command, other flags) untouched. */
function setBypassFlag(command: string, enabled: boolean): string {
  const stripped = command.replace(/\s*--dangerously-skip-permissions\b/g, '');
  if (!enabled) return stripped;
  return stripped.replace(/^(\s*claude)\b/, `$1 ${BYPASS_FLAG}`);
}

/** Slugify a display name into a valid profile id (alphanumeric/-/_). */
function slugifyId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================================
// Sub-components
// ============================================================================

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">{children}</h3>
  );
}

function FieldLabel({ children, optional }: { children: React.ReactNode; optional?: boolean }) {
  return (
    <label className="block text-sm text-zinc-400 mb-1">
      {children}
      {optional && <span className="text-zinc-600 ml-1">(optional)</span>}
    </label>
  );
}

/** One-line explanation under a field — every option should say what it
 *  actually does, so the editor never needs a manual. */
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-zinc-600 mt-1 leading-snug">{children}</p>;
}

function TextInput({
  value, onChange, placeholder, mono,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100
                  placeholder-zinc-600 outline-none focus:border-zinc-500 transition-colors
                  ${mono ? 'font-mono text-xs' : ''}`}
    />
  );
}

// ============================================================================
// Quick Action Editor
// ============================================================================

function ActionEditor({
  actions, onChange,
}: {
  actions: QuickAction[]; onChange: (actions: QuickAction[]) => void;
}) {
  const addAction = () => {
    onChange([...actions, { id: `action-${Date.now()}`, name: '', command: '' }]);
  };

  const updateAction = (index: number, patch: Partial<QuickAction>) => {
    const updated = actions.map((a, i) => i === index ? { ...a, ...patch } : a);
    onChange(updated);
  };

  const removeAction = (index: number) => {
    onChange(actions.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      {actions.map((action, i) => (
        <div key={action.id} className="flex gap-2 items-start">
          <div className="flex-1 space-y-1.5">
            <input
              type="text"
              value={action.name}
              onChange={(e) => updateAction(i, { name: e.target.value })}
              placeholder="Action name"
              className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-xs
                         text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
            />
            <input
              type="text"
              value={action.command}
              onChange={(e) => updateAction(i, { command: e.target.value })}
              placeholder="Command to run"
              className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-xs
                         text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono"
            />
          </div>
          <button
            onClick={() => removeAction(i)}
            className="shrink-0 px-2 py-1.5 text-zinc-600 hover:text-red-400 transition-colors text-xs"
          >
            &times;
          </button>
        </div>
      ))}
      {actions.length < 20 && (
        <button
          onClick={addAction}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          + Add action
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Health Check Editor
// ============================================================================

function HealthCheckEditor({
  healthCheck, onChange,
}: {
  healthCheck: HealthCheck | undefined;
  onChange: (hc: HealthCheck | undefined) => void;
}) {
  if (!healthCheck) {
    return (
      <button
        onClick={() => onChange({ command: '', intervalSeconds: 60, parser: 'exit-code' })}
        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        + Add health check
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={healthCheck.command}
        onChange={(e) => onChange({ ...healthCheck, command: e.target.value })}
        placeholder="Health check command"
        className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-xs
                   text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono"
      />
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-[10px] text-zinc-600 mb-0.5">Interval (sec)</label>
          <input
            type="number"
            value={healthCheck.intervalSeconds}
            onChange={(e) => onChange({ ...healthCheck, intervalSeconds: Math.max(5, parseInt(e.target.value) || 60) })}
            min={5}
            className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-xs
                       text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
        <div className="flex-1">
          <label className="block text-[10px] text-zinc-600 mb-0.5">Parser</label>
          <select
            value={healthCheck.parser}
            onChange={(e) => onChange({ ...healthCheck, parser: e.target.value as HealthCheck['parser'] })}
            className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-xs
                       text-zinc-100 outline-none focus:border-zinc-500"
          >
            <option value="exit-code">Exit Code</option>
            <option value="json">JSON</option>
            <option value="contains">Contains</option>
          </select>
        </div>
      </div>
      {healthCheck.parser === 'contains' && (
        <input
          type="text"
          value={healthCheck.contains || ''}
          onChange={(e) => onChange({ ...healthCheck, contains: e.target.value })}
          placeholder="String to search for"
          className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-xs
                     text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
        />
      )}
      <button
        onClick={() => onChange(undefined)}
        className="text-xs text-red-400/60 hover:text-red-400 transition-colors"
      >
        Remove health check
      </button>
    </div>
  );
}

// ============================================================================
// Profile Editor
// ============================================================================

export function ProfileEditor() {
  const { editingProfile, closeOverlay, saveProfile, deleteProfile, profiles } = useAppStore();

  const isNew = !editingProfile;
  // The ID is immutable only for an existing profile that already *has* a real
  // id. A profile reaching the editor with an empty id (new, or a discovered/
  // legacy entry that never got one) must stay editable — otherwise the
  // read-only field + "ID is required" check becomes an unrecoverable trap.
  const idLocked = !isNew && !!editingProfile?.id?.trim();
  const [form, setForm] = useState<Partial<Profile>>(
    editingProfile ? { ...editingProfile } : { id: '', name: '' },
  );
  const [showAdvanced, setShowAdvanced] = useState(!!(form.healthCheck || form.logOutput));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Group picker: chips from groups that already exist, plus a "new" escape
  // hatch. Typing group names by hand produced near-duplicate groups.
  const [newGroupMode, setNewGroupMode] = useState(false);
  const existingGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const p of profiles) if (p.group?.trim()) groups.add(p.group.trim());
    if (form.group?.trim()) groups.add(form.group.trim());
    return [...groups].sort((a, b) => a.localeCompare(b));
    // form.group is intentionally sampled once — while newGroupMode is active
    // we don't want a chip materializing for every keystroke of the new name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles]);

  const patch = useCallback((updates: Partial<Profile>) => {
    setForm((prev) => ({ ...prev, ...updates }));
    setError(null);
  }, []);

  const autoId = useCallback((name: string) => {
    // Keep the id in sync with the name unless it's locked to an existing
    // profile's id. Covers new profiles and id-less legacy/discovered ones.
    if (!idLocked) {
      patch({ name, id: slugifyId(name) });
    } else {
      patch({ name });
    }
  }, [idLocked, patch]);

  const handleSave = () => {
    if (!form.name?.trim()) { setError('Name is required'); return; }
    // Fall back to a slug of the name if the id is empty (id-less legacy/
    // discovered profiles), so a blank id can never dead-end the form.
    const id = form.id?.trim() || slugifyId(form.name);
    if (!id) { setError('Could not derive an ID from the name — add letters or numbers'); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { setError('ID must be alphanumeric with hyphens/underscores'); return; }

    // Clean up empty optional fields
    const profile: Profile = {
      id,
      name: form.name.trim(),
      ...(form.icon && { icon: form.icon }),
      ...(form.color && { color: form.color }),
      ...(form.cwd?.trim() && { cwd: form.cwd.trim() }),
      ...(form.command?.trim() && { command: form.command.trim() }),
      ...(form.shell?.trim() && { shell: form.shell.trim() }),
      ...(form.group?.trim() && { group: form.group.trim() }),
      ...(form.pinned && { pinned: true }),
      ...(form.actions && form.actions.length > 0 && {
        actions: form.actions.filter(a => a.name && a.command),
      }),
      ...(form.healthCheck?.command && { healthCheck: form.healthCheck }),
      ...(form.logOutput && { logOutput: true }),
      ...(form.env && Object.keys(form.env).length > 0 && { env: form.env }),
      ...(form.cols && { cols: form.cols }),
      ...(form.rows && { rows: form.rows }),
    };

    saveProfile(profile);
    closeOverlay();
  };

  const handleDelete = () => {
    if (!editingProfile || editingProfile.id === 'default') return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    deleteProfile(editingProfile.id);
    closeOverlay();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="shrink-0 px-4 pt-[max(16px,env(safe-area-inset-top))] pb-3 border-b border-zinc-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => closeOverlay()}
              className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded-md
                         active:bg-zinc-700 transition-colors"
            >
              &larr; Back
            </button>
            <h1 className="text-lg font-bold">{isNew ? 'New Profile' : 'Edit Profile'}</h1>
          </div>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-sm bg-zinc-100 text-zinc-900 font-medium rounded-lg
                       active:bg-zinc-300 transition-colors"
          >
            Save
          </button>
        </div>
      </header>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {error && (
          <div className="px-3 py-2 bg-red-900/20 border border-red-900/30 rounded-lg text-red-400 text-xs">
            {error}
          </div>
        )}

        {/* Preview */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex items-center gap-3">
          <span className="text-2xl">{form.icon || '📂'}</span>
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{form.name || 'Untitled'}</div>
            <div className="text-xs text-zinc-500 truncate">
              {form.group || 'No group'}
              {(form.id || form.name) && (
                <span className="text-zinc-700"> · id: {form.id || slugifyId(form.name || '')}</span>
              )}
            </div>
          </div>
          {form.color && (
            <div className="w-2 h-8 rounded-full" style={{ backgroundColor: form.color }} />
          )}
        </div>

        {/* Basic Info */}
        <section className="space-y-3">
          <SectionHeader>Basic Info</SectionHeader>

          <div>
            <FieldLabel>Name</FieldLabel>
            <TextInput value={form.name || ''} onChange={autoId} placeholder="My Project" />
            <Hint>Shown on the home screen and in session tabs. The internal id{idLocked ? ' is locked for an existing profile' : ' is derived automatically'}.</Hint>
          </div>

          <div>
            <FieldLabel optional>Group</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => { setNewGroupMode(false); patch({ group: undefined }); }}
                className={`px-3 py-1.5 rounded-full text-xs transition-colors ${
                  !form.group && !newGroupMode
                    ? 'bg-zinc-700 text-zinc-100 ring-1 ring-zinc-500'
                    : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'}`}
              >
                None
              </button>
              {existingGroups.map((g) => (
                <button
                  key={g}
                  onClick={() => { setNewGroupMode(false); patch({ group: g }); }}
                  className={`px-3 py-1.5 rounded-full text-xs transition-colors ${
                    form.group === g && !newGroupMode
                      ? 'bg-zinc-700 text-zinc-100 ring-1 ring-zinc-500'
                      : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'}`}
                >
                  {g}
                </button>
              ))}
              <button
                onClick={() => { setNewGroupMode(true); patch({ group: undefined }); }}
                className={`px-3 py-1.5 rounded-full text-xs transition-colors ${
                  newGroupMode
                    ? 'bg-zinc-700 text-zinc-100 ring-1 ring-zinc-500'
                    : 'bg-zinc-800 text-zinc-500 active:bg-zinc-700 border border-dashed border-zinc-600'}`}
              >
                + New group
              </button>
            </div>
            {newGroupMode && (
              <div className="mt-2">
                <TextInput value={form.group || ''} onChange={(v) => patch({ group: v })} placeholder="New group name" />
              </div>
            )}
            <Hint>Groups become the sections on your home screen.</Hint>
          </div>

          <div>
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="pinned"
                checked={form.pinned || false}
                onChange={(e) => patch({ pinned: e.target.checked })}
                className="w-4 h-4 rounded bg-zinc-800 border-zinc-600"
              />
              <label htmlFor="pinned" className="text-sm text-zinc-400">Pin to top of home screen</label>
            </div>
            <Hint>Pinned profiles show in their own section above all groups.</Hint>
          </div>
        </section>

        {/* Appearance */}
        <section className="space-y-3">
          <SectionHeader>Appearance</SectionHeader>

          <div>
            <FieldLabel optional>Icon</FieldLabel>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {ICON_OPTIONS.map((icon) => (
                <button
                  key={icon}
                  onClick={() => patch({ icon })}
                  className={`w-9 h-9 rounded-lg flex items-center justify-center text-base
                              transition-colors ${form.icon === icon
                                ? 'bg-zinc-700 ring-1 ring-zinc-500'
                                : 'bg-zinc-800 active:bg-zinc-700'}`}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel optional>Color</FieldLabel>
            <div className="flex flex-wrap gap-2 items-center">
              {COLOR_PRESETS.map((color) => (
                <button
                  key={color}
                  onClick={() => patch({ color })}
                  className={`w-7 h-7 rounded-full transition-all ${form.color === color
                    ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-950 scale-110'
                    : 'hover:scale-105'}`}
                  style={{ backgroundColor: color }}
                />
              ))}
              <button
                onClick={() => patch({ color: undefined })}
                className={`w-7 h-7 rounded-full border border-zinc-700 text-zinc-600 text-xs
                            flex items-center justify-center ${!form.color ? 'ring-2 ring-zinc-500' : ''}`}
              >
                &times;
              </button>
              <input
                type="text"
                value={form.color || ''}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v || /^#[0-9a-fA-F]{0,6}$/.test(v)) patch({ color: v || undefined });
                }}
                placeholder="#hex"
                className="w-20 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs font-mono
                           text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
              />
            </div>
          </div>
        </section>

        {/* Session Config */}
        <section className="space-y-3">
          <SectionHeader>Session Config</SectionHeader>

          <div>
            <FieldLabel optional>Working Directory</FieldLabel>
            <TextInput
              value={form.cwd || ''} onChange={(v) => patch({ cwd: v })}
              placeholder="~/projects/my-app" mono
            />
            <Hint>Folder the session starts in. Defaults to your home folder.</Hint>
          </div>

          <div>
            <FieldLabel optional>On-Connect Command</FieldLabel>
            <TextInput
              value={form.command || ''} onChange={(v) => patch({ command: v })}
              placeholder="claude '/myproject'" mono
            />
            <Hint>Typed into the terminal automatically when the session is created — start Claude, tail logs, ssh somewhere.</Hint>
          </div>

          {isClaudeCommand(form.command || '') && (
            <div>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="bypass-permissions"
                  checked={hasBypassFlag(form.command || '')}
                  onChange={(e) => patch({ command: setBypassFlag(form.command || '', e.target.checked) })}
                  className="w-4 h-4 rounded bg-zinc-800 border-zinc-600"
                />
                <label htmlFor="bypass-permissions" className="text-sm text-zinc-400">
                  Skip permission prompts <span className="text-amber-500">(bypass mode)</span>
                </label>
              </div>
              <Hint>
                Adds <span className="font-mono text-zinc-500">{BYPASS_FLAG}</span> to the command.
                Claude runs every tool without asking — no confirmations for file edits, shell commands, or deletes.
                Only for projects you trust.
              </Hint>
            </div>
          )}
        </section>

        {/* Quick Actions */}
        <section className="space-y-3">
          <SectionHeader>Quick Actions</SectionHeader>
          <Hint>One-tap commands on the profile card — run without opening the terminal, output shows in a popup. Good for status checks, restarts, deploys.</Hint>
          <ActionEditor
            actions={form.actions || []}
            onChange={(actions) => patch({ actions })}
          />
        </section>

        {/* Advanced */}
        <section className="space-y-3">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
          >
            <span className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`}>&rsaquo;</span>
            Advanced
          </button>

          {showAdvanced && (
            <div className="space-y-4 pl-2 border-l border-zinc-800">
              <div>
                <FieldLabel optional>Health Check</FieldLabel>
                <Hint>A command run on a timer; its result puts a green/red dot on the profile card. Exit Code = healthy when it exits 0; Contains = healthy when the output includes your string.</Hint>
                <HealthCheckEditor
                  healthCheck={form.healthCheck}
                  onChange={(hc) => patch({ healthCheck: hc })}
                />
              </div>

              <div>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="log-output"
                    checked={form.logOutput || false}
                    onChange={(e) => patch({ logOutput: e.target.checked })}
                    className="w-4 h-4 rounded bg-zinc-800 border-zinc-600"
                  />
                  <label htmlFor="log-output" className="text-sm text-zinc-400">Log session output</label>
                </div>
                <Hint>Captures this profile&apos;s output to server-side logs (Settings → Session logs) — searchable even after the session dies. Stays on the server, 14-day/200MB cap. Off = nothing recorded.</Hint>
              </div>
            </div>
          )}
        </section>

        {/* Delete */}
        {!isNew && editingProfile?.id !== 'default' && (
          <section className="pt-4 border-t border-zinc-800">
            <button
              onClick={handleDelete}
              className={`w-full py-3 rounded-xl text-sm font-medium transition-colors ${
                confirmDelete
                  ? 'bg-red-600 text-white active:bg-red-700'
                  : 'bg-red-900/20 border border-red-900/30 text-red-400 active:bg-red-900/30'
              }`}
            >
              {confirmDelete ? 'Confirm Delete' : 'Delete Profile'}
            </button>
            {confirmDelete && (
              <button
                onClick={() => setConfirmDelete(false)}
                className="w-full mt-2 py-2 text-xs text-zinc-500 active:text-zinc-300"
              >
                Cancel
              </button>
            )}
          </section>
        )}

        {/* Bottom spacer for mobile */}
        <div className="h-8" />
      </div>
    </div>
  );
}
