# PersaLink → Play Store: "easy for everyone" — the blueprint

Deep archplan 2026-08-16 (supersedes the 2026-08-15 phase list; Phase 1 shell
work from that doc is DONE and recorded at the bottom). Interview answers,
research (FCM/Play policy/plugins), and adversarial pre-mortem all folded in.

## The Ask
Ship PersaLink as a free Play Store app that a stranger with a spare
Linux/Mac box can go from zero → terminal-on-phone in 5 minutes, without
breaking the author's own daily-driver setup.

## The Insight
The product already exists — this is a **packaging, pairing, and trust**
project. The three real deliverables are: (1) a pairing flow with zero
address/password typing, (2) alerts that work like a real app, (3) release
discipline so the public churn never touches the stable personal instance.

## Locked decisions (interview 2026-08-16)
1. Self-hosters only; NO hosted session relay (non-goal, keeps scope sane)
2. Install = `npx persalink` (Node prereq accepted; single binary = later)
3. Remote path = Tailscale (documented happy path); LAN = zero-setup
4. Pairing = ANSI QR + one-time token; `pair --code` fallback; manual last
5. Push = FCM in the shell; self-hosted VAPID stays for browsers
6. Free app, no license gates
7. PRIVATE code; public issues-only support repo (see ⚠️ flag below)
8. Android-only; iPhone → PWA (works incl. push)
9. Launch bar = polish-first: full package before any public link
10. One codebase, separated channels: box runs pinned stable tag;
    `persalink-beta` pm2 instance takes churn; Play builds from tags only

## Ruling: the FCM contradiction (pre-mortem #1)
"No hosted infra" and "FCM at launch" collide: FCM requires ONE Firebase
service-account credential, which must never ship inside the npm package
(instant leaked secret). Every serious self-hosted app (Home Assistant is
the canonical precedent — `mobile-apps-fcm-push`, 500 notifs/device/day cap)
solves this with a **tiny developer-hosted push relay**.

**Ruling: build the relay, scoped as the ONE hosted exception.** It is
stateless (no accounts, no storage), sits on Vercel (house platform, free
tier), holds the Firebase credential in env, and forwards
`{fcmToken, title, body, tag}` with per-token rate limiting (HA-style daily
cap). Sessions/terminals NEVER touch it — it is notification-only, and the
README documents a shutdown story (app falls back to connected-only alerts).
Softened decision #1: "no hosted infra *in the session path*."

## ⚠️ Flagged, user's call stands: private code
Pre-mortem rates closed source as the top community risk for THIS audience
("closed-source remote shell" is a launch-post-killing comment). Decision
stands (free app, private repo), but the middle path stays on the table:
**open only the server half** later if reception demands it — it's the
trust-critical part, and pledging "server goes open if I stop maintaining"
blunts both the trust and abandonment objections at zero present cost.

## Design

### Pairing protocol (Phase B)
- Server: `persalink pair` (and first boot) prints via `qrcode`
  (`toString(..., { type: 'terminal', small: true })`, EC level L, compact
  payload): `persalink://pair?h=<lan>&t=<tailnet>&k=<one-time-token>`
  plus the same as a short typed code. Headless = QR renders over SSH.
- Token: single-use, 10-min TTL, rate-limited endpoint, timing-safe compare,
  exchanged for a normal device token (existing token store). Pre-auth
  endpoint must be covered by the same origin/rebinding guards as WS.
- App: "Scan server QR" via `@capacitor/barcode-scanner` (official, v3.x,
  full-screen native scan, simplest). Tries LAN host then tailnet; stores
  entry with tls flag from the URL scheme.
- Token lifecycle: device tokens auto-renew when <30 days from the 365-day
  cap (auth.ts hard cap) — silent-expiry 1-stars pre-empted. Auth failure →
  explicit "re-pair with your server" screen, not a spinner.

### Notifications (Phase C)
- `@capacitor/push-notifications` v8.1.x; `google-services.json` lives in the
  private repo; POST_NOTIFICATIONS runtime permission; notification channel.
- Server: pushManager grows an FCM path next to VAPID — subscriptions carry
  `{kind: 'webpush'|'fcm', target}`; FCM targets deliver via the relay.
- Relay: Vercel function `push-relay` (separate tiny repo or /relay dir):
  validates shape, rate-limits per token (KV counter), forwards via
  firebase-admin HTTP v1. No auth accounts — abuse controls = rate caps +
  payload size caps + token validity.
- Existing per-event prefs (finished/waiting/error) apply unchanged.
- Data-safety form impact: FCM = device identifiers, declared honestly.

### Stranger-proofing (Phase D)
- **Offline demo mode** (pre-mortem #2, triple-duty): "Try the demo" on the
  empty first-run screen plays a canned session (scripted xterm feed) —
  fixes Play review dead-end, provides store screenshots, converts the
  empty state into onboarding. Reviewer notes in Play Console "App access"
  point at it explicitly.
- Version handshake: client+server exchange PROTOCOL_VERSION both ways with
  a min-supported floor; too-old server → actionable screen naming the fix
  (`npm i -g persalink@latest`). Additive-only protocol changes; CI compat
  job runs new client against last 2 tagged server releases.
- In-app **diagnostics screen** (support deflection, solo-maintainer oxygen):
  LAN/tailnet reachability, server version, WS probe, clock skew → one
  copy-pasteable report. Support repo issue template asks for it.
- Claude-neutral pass: "Session alerts" copy; first-run profile presets
  (Shell, SSH to another box, Docker logs, htop) + Claude preset as one of
  many; hide the web update pill in the shell (Play owns app updates).
- Security hardening from pre-mortem: warn loudly when server binds
  non-RFC1918 without TLS; pairing endpoint rate limits; beta isolation.

### Release engineering (Phase A — FIRST, protects the daily driver)
- **Fix `pushManager.ts` CONFIG_DIR bug** (hardcodes `~/.persalink`, ignores
  `PERSALINK_CONFIG_DIR` — found by pre-mortem; beta would share push state
  with stable, and TokenStore corruption fails closed = bricked stable).
- `persalink-beta` pm2 instance: own config dir + port, added to
  ecosystem.config.js; box's main instance pinned to a stable tag, upgraded
  deliberately.
- Play builds from tags only; keystore = NEW one (never reuse freecost's);
  versionCode bump discipline; `targetSdkVersion 36` (Play requires API 36
  for new apps as of 2026-08-31 — submission-blocking, verify Capacitor 8).
- Release gate (every tag): clean-VM `npx persalink@latest` → QR pair →
  connected; new client vs last 2 server tags.

## Pre-mortem (top 3 of 6, full report absorbed into work items)
1. FCM/hosted-infra contradiction → RESOLVED above (relay ruling).
2. Play review dead-end (no server = no functionality) → demo mode +
   reviewer notes; data-safety redone when FCM lands; cleartext justified.
3. Broken stranger funnel (npm 1.0.3 broken TODAY; pre-fbe8226 servers
   reject the shell's origin) → npm fix is launch-blocking (USER:
   NPM_TOKEN); handshake makes old-server failures actionable.
Also: version skew (handshake+CI), closed-source blowback (flag above),
token/pairing security + beta isolation (Phase A/B items).

## Build order
- **Phase A — Foundations/non-interference:** CONFIG_DIR bug; beta instance;
  tag+channel discipline; targetSdk 36; version handshake.
- **Phase B — Pairing:** server QR/pair command + token protocol +
  hardening; app scanner + re-pair/renewal UX.
- **Phase C — Notifications:** Firebase project; Vercel relay; server FCM
  path; app plugin; prefs wiring; data-safety notes.
- **Phase D — Stranger-proofing:** demo mode; presets + neutral copy;
  diagnostics screen; hide web-update pill; TLS warning.
- **Phase E — Launch package:** icon/splash; landing page + privacy policy;
  store listing (Titan square-screen shots ARE the marketing); closed
  testing; factory-reset self-onboarding test using only the README; then
  the Unihertz/r/unihertz post.
- **USER-owed, launch-blocking:** NPM_TOKEN (npm 1.0.3 broken), Firebase +
  Play Console setup clicks, keystore custody, name/trademark sanity check.

**Complexity: Complex** — ~5-6 focused build sessions + store bureaucracy;
the relay and pairing protocol are small but security-sensitive.

## Decision log
- Relay = ONE hosted exception (stateless, notification-only, Vercel) —
  because FCM credentials can't ship in installs (HA precedent, IAM rules).
- Demo mode over demo server — no live shell handed to reviewers; fixes
  three problems in one feature.
- Handshake + additive-only protocol — Play fleet-updates in 48h, servers
  rot for years; the origin change already broke old servers once.
- Private code stands (user call) with server-open-later escape hatch.
- Launch without FCM was considered and rejected — alerts are the killer
  feature for this exact audience; polish-first bar includes them.

---

## Record: Phase 1 shell (DONE 2026-08-15, commit fbe8226)
Capacitor android project in `apps/client/android`; `lib/platform.ts`
(isNativeShell/pageHost/schemesFor); `ServerEntry.tls` transport pinning;
server accepts shell localhost origins; usesCleartextTraffic +
allowMixedContent; debug APK builds on the box (`cd apps/client/android &&
./gradlew assembleDebug`), sideload copy at `~/shared/persalink-apk/`.
Gotchas: shell origin vs old servers; mixed-content needs allowMixedContent;
stale empty `android/` dir from March was rmdir'd.
