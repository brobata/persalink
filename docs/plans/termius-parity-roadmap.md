# Termius-Parity Roadmap — "make PersaLink awesome"

**Status:** planned 2026-08-12 · source: Termius Android changelog mined for polish patterns
**Frame:** Termius = general SSH client for strangers' servers. PersaLink = orchestrator
with a TRUSTED daemon on every box (can read shell history, log server-side, run
snippets fleet-wide). Steal their sanding, apply our unfair advantage.

**Already ahead of Termius Android:** tmux persistence model, mobile split panes,
multi-server per-pane grids, attention states + push, session previews, update pill,
voice input, biometric lock, link harvester. Gap = polish density, not architecture.

## 🏆 THE BEST — sequential tracks (a track is done when its A→B arc closes)

### Track 1 — Gorgeous & Feel — ✅ COMPLETE 2026-08-12
Session 1 (f56d792): theme pack (16), Nerd Font symbols fallback in every stack,
mobile follows the style store (was hardcoded!) + palette button → bottom-sheet
settings, swatch grid, arrow joystick w/ gears + haptics, double-tap Tab (+toggle),
pinch zoom, Space trackpad key. Session 2: in-place selection handles — hold a word,
release → xterm-rendered highlight + two draggable teardrop handles (linear cell-index
math, crossover-safe) + floating Copy/Paste/All menu; handles track normal-buffer
scrolls, dismiss on alt-screen scroll (app redraws under them) and on any terminal
touch; blank-area hold falls back to the full-text modal. E2E-verified with synthetic
TouchEvents: hold → handles+menu → Copy → exact word on clipboard. Still owed: user's
on-phone tuning pass (arm delay / gear distances / handle size are one-line tweaks).
Theme pack: import ~12-15 canonical schemes as data into terminalStyleStore
(Dracula, Nord, Catppuccin Mocha/Latte, Gruvbox, Tokyo Night, Rosé Pine, Everforest,
Kanagawa, Ayu Mirage, Night Owl, Solarized Dark, One Dark) → swap one bundled font for
its **Nerd Font** build (powerline/devicon glyphs stop rendering as boxes) → theme
preview swatches in TerminalSettings instead of a dropdown → **gesture pack** (full
Termius spec, user-supplied 2026-08-12; all in TerminalScreen's existing touch pipeline;
arbitration: hold+drag=arrows · hold+release=selection · double-tap=Tab · two-finger=
zoom · plain drag=scroll — NO mode toggles):
1. **Arrow joystick**: 500ms hold arms w/ haptic tick; drag direction = dominant axis
   from origin; continuous repeat whose RATE scales with drag distance (speed gears,
   ~150/80/40ms tiers). Haptic tick per gear shift.
2. **Space-key trackpad**: add Space to the key bar — tap = space, hold+slide = arrows.
3. **Double-tap = Tab** (completion) — on by default, settings toggle (Tab isn't always
   harmless in TUIs).
4. **Pinch-to-zoom** font (live fit + persisted).
5. **In-place selection handles**: hold a word + release → selection handles drawn as an
   overlay above the canvas (xterm buffer-coord APIs), drag to extend, context menu with
   **Copy + Paste**. Select & copy modal remains as "full text view" fallback.
Key-bar arrows stay as precision fallback. SKIP tap-to-reposition-cursor (readline can't
seek; only ever half-works — Termius skips it too). Expect a slop/threshold tuning pass
on the real phone; selection handles are the priciest item.

### Track 2 — Text out — ✅ SHIPPED 2026-08-13 (faa5a8b)
**OSC 52 clipboard bridge** (tmux `set -s set-clipboard on`, pass sequence through PTY,
client writes navigator.clipboard; xterm clipboard addon) → **find-in-scrollback**
(xterm search addon, 🔍 top bar, next/prev + highlight) → **server-side session logs**
(`tmux pipe-pane` → rotated files in ~/.persalink/logs/, Logs screen to browse/search
dead sessions). Logs: per-profile opt-in, size+age caps, never leave the owning server.

### Track 3 — Type less — ✅ SHIPPED 2026-08-13 (29999b0)
**Suggestion bar**: server harvests shell history (bash/zsh, deduped, frecency) + profile
quick-action commands; ship top ~500 to client ONCE per attach; local fuzzy match,
tap-to-insert chips above the key bar (sub-50ms, never per-keystroke round-trips) →
**global snippet library** (server-side beside profiles: name, command, {{variable}}
placeholders prompted at run, insert-into-terminal OR run-detached; migrate/alias Quick
Actions) → **multi-target run** across sessions/servers via the registry, per-target
results. (Termius charges for that last one; our fleet model gets it nearly free.)
Protocol: `snippets.*`, `history.suggest`.

### Track 4 — Files — ✅ SHIPPED 2026-08-13 (431afe1; File-Share ruling 2026-08-12)
**Ruling: integrate the capability, not the app.** File-Share (brobata/file-share,
LAN :4040) stays a separate shipped product — grafting fails on auth mismatch, the
https→http mixed-content wall, and the fleet argument (Files must ride the daemon so
every registry server has it automatically). Instead: **port File-Share's backend core**
(path-traversal guards, mime/preview, download streaming — Express code that drops into
persalink's httpServer) behind token auth → browse/preview/download per server, starting
at profile cwd, audit-logged → crib File-Share's validated UI patterns for the React
screens → **courtesy glue**: health-probe :4040 per host and show "Open in File-Share ↗"
(top-level nav, mixed content doesn't apply). SKIP rename/move/delete/multi-select —
the terminal does those better; File-Share covers heavy file management on the LAN.

### Track 5 — Launch fast — ✅ SHIPPED 2026-08-13 (c848ad9)
**PWA manifest shortcuts** (long-press icon → top pinned profiles; deep-link plumbing
exists via `/?session=`) → **Recent strip** on home (sessions attached <24h ago first).

**ALL FIVE TRACKS SHIPPED 2026-08-12/13.** Build-session gotchas worth keeping:
tmux keeps the outer xterm permanently in the alternate buffer (alt-screen checks are
useless — prompt-marker heuristics instead, '> ' excluded so Claude Code never
triggers); phone-width prompts WRAP so logical-line rebuilds must walk isWrapped rows;
`window.__plStore` debug handle exists for browser automation; CSP font-src needs
data:. Remaining from the tracks: on-phone gesture tuning pass (user).

## 👍 THE GOOD (after the Best)
- Settings sync across devices (prefs server-side per token) — after Track 1.
- AI command help via local Ollama gpt-oss:20b (NL → command, preview before run).
- Bottom-tab mobile nav (Sessions/Servers/Snippets/Settings) — do WITH snippet library.
- Connection diagnostics screen (surface audit log: disconnect reason, latency, origin hints).
- Light theme + auto day/night — only if PersaLink goes public-first.
- Friendly bare-session names (from cwd/first command) — any gap week.

## 🗑️ THE SKIPS (decided — don't relitigate)
- SSH key mgmt / FIDO2 / post-quantum / OpenSSH certs / PPK: PersaLink isn't an SSH
  client; trust boundary is the server token, transport is WSS to our own daemon.
- Host chains/bastion, mosh, telnet, serial, SOCKS, port forwarding: Tailscale IS the
  transport layer and is better at it.
- Team Vault / sharing / SSO / 2FA mandates / presence: single-operator product.
- AWS/DO import, S3 SFTP: servers join by running the daemon; no cloud inventory.
- Native Android widget: needs a native app; manifest shortcuts = 80% value, 2% cost.

## Pre-mortem
1. Polish sprawl → tracks are strictly sequential.
2. Session logs leak secrets → server-local only, per-profile opt-in, capped, purge with session.
3. Laggy autocomplete → local matching against a once-per-attach history snapshot only.
