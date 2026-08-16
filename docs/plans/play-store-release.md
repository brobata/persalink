# PersaLink → Play Store (Titan-first) — release track

Decision 2026-08-15. Goal: PersaLink as an installable Android app marketed to
Titan/keyboard-phone users (≈ terminal nerds = the ICP), useful to non-Claude
users. Companion parked plan: `titan2-ime.md`.

## Architecture

Self-hosted servers → no single-origin TWA. **Capacitor shell bundles the
client dist**; users connect out via the in-app multi-server registry (which
already exists and is the onboarding). `apps/client/capacitor.config.ts`,
native project in `apps/client/android/` (committed; build outputs ignored).

## Phase 1 — the working shell (DONE 2026-08-15)

- [x] `lib/platform.ts`: isNativeShell / pageHost / schemesFor — every
      origin-derived default (implicit server, ws/http scheme) switches off
      in the shell (its origin is the bundled localhost webview).
- [x] `ServerEntry.tls`: typed scheme pins transport (https/wss → TLS,
      http/ws → plain, none → page-protocol fallback, plain in the shell).
      Applied in connect(), remoteServer, upload, FilesScreen, health probes.
- [x] Server accepts native-shell origins (https/http/capacitor://localhost)
      in the WS origin allowlist — browsers can't fake localhost origins, so
      the DNS-rebinding defense is intact.
- [x] Capacitor android project; usesCleartextTraffic + allowMixedContent
      (self-hosted servers are plain ws/http on LAN/tailnet).
- [x] Debug APK builds on the box (`cd apps/client/android && ./gradlew
      assembleDebug`); sideload from `~/shared/persalink-apk/`.

## Phase 2 — polish for strangers

- [ ] First-run add-server UX: QR pairing (server prints QR with host+scheme;
      app scans) — the single biggest setup-friction killer.
- [ ] App icon + splash (real assets, not Capacitor defaults).
- [ ] Notifications in the shell: WebView has no PushManager → Settings copy
      should say so honestly; native FCM path is a later heavy lift (server
      would need FCM delivery next to VAPID).
- [ ] Neutral copy pass: "Session alerts" not "Agent alerts"; profile presets
      (shell / ssh / docker logs / htop) beside the Claude preset.
- [ ] Optional per-profile watch regex ("notify when output matches X").
- [ ] In-shell update UX: the bundled client updates via Play, not the
      server's /version.json — hide the web update pill in the shell.

## Phase 3 — Play bureaucracy

- [ ] Release keystore (NEW one — do not reuse freecost-upload.keystore),
      signed AAB, versionCode discipline (bump every upload).
- [ ] Play Console listing: screenshots (Titan square-screen shots are the
      marketing), feature graphic, privacy policy URL, data-safety form
      (no data collected — servers are the user's own).
- [ ] Internal testing track first (same flow as Freecost).
- [ ] Server one-liner for strangers: fix npm (USER owes NPM_TOKEN — 1.0.3 is
      broken), README quickstart, and the app's empty-state should link it.
- [ ] Launch post in the Unihertz/Titan community + r/unihertz.

## Gotchas encoded

- Shell origin is https://localhost → old servers reject the WS (origin
  allowlist). Server ≥ this commit required; the ConnectScreen amber hint
  covers older servers.
- Health probes from the https://localhost page to http servers = mixed
  content → allowMixedContent:true in capacitor.config is load-bearing.
- Empty `apps/client/android/` dir existed from a March attempt — cap add
  refuses on existing dir; it was rmdir'd.
