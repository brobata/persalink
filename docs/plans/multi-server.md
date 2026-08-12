# Multi-Server PersaLink

**Status:** Phase 1 built 2026-08-12 · Phase 2 planned
**Origin:** archplan session 2026-08-01 ("can PersaLink have local terminals?" → every
machine you want terminals on runs a server; the client learns about the fleet).

## The Ask

Let the client manage and connect to multiple PersaLink servers (dev box, laptop, Pi…)
instead of one hardcoded `serverUrl` + `authToken`.

## The Insight

A "terminal on machine X" = "the PersaLink server runs on machine X". The server side
needs nothing; the client's single-server assumptions are the entire feature. The npm /
setup.sh release path (v1.0.4+) makes per-machine install trivial, which is what makes
this feature worth having.

## Phases

### Phase 1 — server registry + switching (BUILT)

- `ServerEntry { id, label, host, useOrigin, authToken, serverName, lastConnectedAt }`
  persisted in the zustand store (storage version 1 + migration lifting the old scalar
  `serverUrl`/`authToken` into entry #1 — nobody re-authenticates).
- `serverUrl` / `authToken` / `serverName` remain top-level state as **live mirrors of
  the active entry** — every existing consumer (GridLayout→TerminalPane, upload.ts,
  SettingsScreen) keeps working with zero changes.
- ConnectScreen → **Servers screen**: saved list w/ green/grey health dots (2.5s
  no-cors probe of each server's `/health`), tap to switch, add form (label + host),
  remove. Reachable while connected (home-header chip) with a Back affordance.
- `useOrigin` entries resolve their host from `window.location.host` at connect time —
  preserves the "same server, many names" aliasing (LAN IP vs ts.net vs mDNS) that the
  old pageHost-preference hack provided, but scoped to the entry that IS the page origin.
  Added entries connect to exactly the typed host.
- **Connection generation guard**: each `connect()` bumps a generation; messages and
  state-changes from a superseded socket are dropped. Kills the switch race (late
  `sessions.list` from server A resurrecting its sessions on server B's screen).
- Auth: `auth.ok` tokens write to the active entry + mirror; `auth.failed` clears both
  (other entries untouched). Biometric keychain slot keeps holding the active server's
  token (unchanged single-slot semantics).
- On switch: sessions/profiles/layout cleared, `lastActiveSessionId` dropped (it's
  per-server state; auto-reattach only survives restarts on the same server).
- **Origin-403 UX**: cross-origin entry + healthy probe + failed WS ⇒ show the exact
  `allowedOrigins` line to add to that server's `~/.persalink/config.json`. The server
  rejects cross-origin WS by design (`config.security.allowedOrigins`, default
  same-origin only); the failure must be explained, never a silent spinner.
  (Android TWA sends the server's own origin — unaffected.)

### Phase 2 — per-pane server selection (desktop) — NOT BUILT

Panes already own independent, self-authenticating WSClients (`TerminalPane`), so:
give each pane a `serverId`, resolve host+token from the registry, pane header gets a
server picker + server-colored dot. Dev-box session next to laptop session in one grid.
Session-id keys in layoutStore become `(serverId, sessionId)` at this point.

### Deferred / ruled

- **Push notifications stay primary-server-only** — a Web Push subscription binds to one
  VAPID keypair; multi-server push = keypair distribution problem, not worth it yet.
- Merged all-server session list (N background sockets): revisit after Phase 2, desktop
  only — N reconnect/liveness machines on a phone radio is hostile.
- Hub/proxy relay (one socket, primary forwards): rejected — keystroke latency is sacred.

## Pre-mortem guardrails

1. Switch race → generation guard (above).
2. Migration eats the token → versioned migrate, tested by seeding v0 localStorage in a
   real browser before shipping; old keys left readable.
3. Origin rejection reads as network failure → explicit hint UX (above).
