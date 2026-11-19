/**
 * @file SessionSwitcher
 * @description The one session switcher sheet (phone terminal, phone Home):
 *   every live session in the named groups (Needs you, Working, Quiet,
 *   Ended), longest wait first, each row renamable in place; and the one
 *   "New session" sheet that starts a session from a profile. Moved out of
 *   TerminalScreen so Home mounts the same two sheets.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Pencil, Plus, SquareTerminal } from 'lucide-react';
import { getInitialDims } from '../../lib/terminalDims';
import type { Profile, SessionInfo } from '@persalink/shared/protocol';
import { useAppStore } from '../../stores/appStore';
import { useActiveOrder } from '../../lib/sessionOrder';
import { startProfile } from '../../lib/openSession';
import { countStates, groupOf, needsSentence, sessionTitle, stateKey } from '../../lib/sessionState';
import { Sheet } from './Sheet';
import { SessionRow } from './SessionRow';
import { StateGlyph } from './StateGlyph';
import { ProfileTile } from './ProfileTile';
import { IconButton } from './IconButton';

// One switcher row: the shared SessionRow plus a rename pencil. The pencil
// swaps the row into an inline rename input — the only way to rename a
// session from inside the terminal on a phone.
function SwitcherRow({ s, active, onPick }: {
  s: SessionInfo;
  active: boolean;
  onPick: (id: string) => void;
}) {
  const renameSession = useAppStore((st) => st.renameSession);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');

  const commitEdit = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== s.name) renameSession(s.id, trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2.5 min-h-(--pl-row-h) px-2.5 rounded-[10px] bg-bg-3">
        <StateGlyph state={stateKey(s)} />
        <input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
          }}
          aria-label="Session name"
          className="flex-1 min-w-0 h-9 px-2.5 bg-bg-1 border border-line-2 rounded-[6px] text-body text-fg-1 outline-none focus:border-line-3"
          autoFocus
        />
      </div>
    );
  }

  return (
    <SessionRow
      session={s}
      current={active}
      // One line per row; a waiting agent keeps its question.
      detail={groupOf(stateKey(s)) === 'needs' ? 'auto' : 'never'}
      onOpen={() => onPick(s.id)}
      trailing={(
        <IconButton label={`Rename ${sessionTitle(s)}`} onClick={() => { setEditName(s.name || s.profileName || ''); setEditing(true); }}>
          <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
        </IconButton>
      )}
    />
  );
}

// Quick session switcher: every live session in one Active list (waiting
// first, then newest started first, so rows stay put while agents flip
// between working and quiet), and Ended folded under it.
export function SessionSwitcher({ sessions, currentId, onPick, onNew, onClose }: {
  sessions: SessionInfo[];
  currentId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const ordered = useActiveOrder(sessions);
  const groups = [
    { id: 'active', label: 'Active', items: ordered.filter((s) => groupOf(stateKey(s)) !== 'ended') },
    { id: 'ended', label: 'Ended', items: ordered.filter((s) => groupOf(stateKey(s)) === 'ended') },
  ].filter((g) => g.items.length > 0);
  const c = countStates(sessions);
  return (
    <Sheet
      title="Sessions"
      sub={`${needsSentence(c.waiting)} · ${sessions.length} live`}
      tall
      onClose={onClose}
      headExtra={(
        <button
          type="button"
          onClick={onNew}
          className="shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[6px] border border-line-2 text-meta font-medium text-fg-1 active:bg-bg-3"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
          New
        </button>
      )}
    >
      {sessions.length === 0 && (
        <div className="px-3 py-8 text-center text-body text-fg-3">No live sessions</div>
      )}
      {groups.map((g) => (
        <SwitcherGroup key={g.id} label={g.label} count={g.items.length} startFolded={g.id === 'ended'}>
          {g.items.map((s) => (
            <SwitcherRow key={s.id} s={s} active={s.id === currentId} onPick={(id) => { onPick(id); onClose(); }} />
          ))}
        </SwitcherGroup>
      ))}
    </Sheet>
  );
}

function SwitcherGroup({ label, count, startFolded, children }: {
  label: string;
  count: number;
  startFolded: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!startFolded);
  return (
    <section className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full h-8 flex items-center gap-1.5 px-2 text-left text-meta font-semibold text-fg-2"
      >
        <ChevronRight className={`w-3.5 h-3.5 text-fg-4 transition-transform duration-(--d-move) ${open ? 'rotate-90' : ''}`} strokeWidth={1.75} />
        <span>{label}</span>
        <span className="font-medium text-fg-3 tnum">{count}</span>
      </button>
      {open && <div>{children}</div>}
    </section>
  );
}

export function NewSessionSheet({ onClose }: { onClose: () => void }) {
  const { profiles, sessions, createSession } = useAppStore();

  const grouped = useMemo(() => {
    const groups = new Map<string, Profile[]>();
    for (const p of profiles) {
      const g = p.group || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(p);
    }
    return groups;
  }, [profiles]);

  return (
    <Sheet
      title="New session"
      sub="From a profile, or a plain shell"
      onClose={onClose}
      footer={(
        <div className="flex gap-2 px-3 py-2.5 border-t border-line">
          <button type="button" className="pl-btn flex-1" onClick={() => { const { cols, rows } = getInitialDims(); createSession(undefined, cols, rows); }}>
            <SquareTerminal className="w-4 h-4" strokeWidth={1.75} />Plain shell
          </button>
          <button type="button" className="pl-btn flex-1" onClick={() => { onClose(); useAppStore.getState().editProfile(null); }}>
            <Plus className="w-4 h-4" strokeWidth={1.75} />New profile
          </button>
        </div>
      )}
    >
      {profiles.length === 0 && (
        <p className="px-3 py-8 text-center text-body text-fg-3">No profiles yet.</p>
      )}
      {Array.from(grouped.entries()).map(([group, profs]) => (
        <section key={group} className="mt-1.5">
          <h3 className="h-8 flex items-center px-2 text-meta font-semibold text-fg-2">{group}</h3>
          {profs.map((p) => {
            const live = sessions.filter((x) => x.profileId === p.id).length;
            return (
              <button
                key={p.id}
                type="button"
                // The store closes the picker when the new session attaches.
                onClick={() => startProfile(p.id)}
                className="w-full flex items-center gap-3 min-h-(--pl-row-h) px-2.5 rounded-[10px] text-left active:bg-bg-3 hover:bg-bg-3/60 transition-colors duration-(--d-press)"
              >
                <ProfileTile name={p.name} icon={p.icon} color={p.color} />
                <span className="flex-1 min-w-0 truncate text-[14px] font-medium text-fg-1">{p.name}</span>
                {live > 0 && <span className="shrink-0 text-micro text-fg-3 tnum">{live} live</span>}
              </button>
            );
          })}
        </section>
      ))}
    </Sheet>
  );
}
