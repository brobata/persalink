# Titan 2 IME — parked plan (2026-08-15)

A custom Android keyboard (IME) for the Unihertz Titan 2 / 2 Elite. Parked in
favor of shipping PersaLink to the Play Store first. Revisit after a month of
daily Titan use — by then the must-have list will be obvious.

> **⚠️ 2026-08-15 reassessment: Pastiera changes the math — see bottom.**
> The "nobody has built one for the Titan 2 generation" premise below is
> stale, and Phases 0–2 are mostly obsolete. Original plan kept for record.

## Why (original premise — now outdated)

- ~~The Titan community hand-rolled IMEs for the old Titan Pocket
  (titanpocketkeyboard, PocketBoard, TitanPad) — proven demand, and **nobody
  has built one for the Titan 2 generation yet** (first-mover gap).~~
  **WRONG as of Aug 2026: Pastiera explicitly targets the Titan 2** (device
  behavior snapshots for it are archived in its repo).
- An IME fixes typing once, system-wide, instead of per-app key bars.
- Perfect complement to PersaLink: IME owns typing, PersaLink owns sessions.
  Each markets the other to the same few thousand keyboard-phone nerds.

## Feature set (pain-ranked) — vs. Pastiera

1. Real modifiers: sticky Ctrl (Sym then C = Ctrl+C anywhere), Esc, Tab,
   arrows on a layer (hold-Sym → WASD = ↑←↓→).
   **✅ Pastiera has this**: sticky Shift/Ctrl/Alt (one-shot + double-tap
   lock), Ctrl+C/X/V/A, custom arrow mappings, "Nav Mode" (ESDF/IJKL
   navigation outside text fields).
2. Dev-sane symbol layer (| ~ ` {} predictable).
   **✅ Pastiera has this**: dual symbol pages, multi-tap variants,
   custom SYM/Ctrl maps with JSON import/export, web layout editor
   (pastierakeyedit.vercel.app).
3. Autocorrect that knows its place — off in terminals, per-app profiles.
   **⚠️ GAP**: Pastiera's dictionary suggestions are experimental (need
   Shizuku); no documented per-app profile system.
4. Swipe-on-keycaps cursor movement (SPECULATIVE — see risk).
   **⚠️ DIFFERENT**: Pastiera swipes live on its on-screen variations bar,
   not the physical keycaps. Keycap-touch go/no-go question still open —
   but now a nice-to-have, not a product foundation.
5. Long-press alternates, clipboard strip, emoji search.
   **partial**: long-press variants yes; clipboard strip / emoji search
   partial.

## Risk map (original)

- Key events (1–3): LOW — physical presses are standard KeyEvents; the
  Pocket IMEs prove the pattern.
- Keycap touch surface (4): UNKNOWN on Titan 2 — Unihertz's Scroll Assistant
  consumes swipes at system level; whether an IME still sees raw motion
  events on this generation is the go/no-go question. PocketBoard proved it
  readable on the Pocket.
- Native Kotlin only (InputMethodService) — no Expo/RN path. Dev loop =
  sideload debug APKs on the Titan via adb.
- Maintenance: firmware updates can shuffle keycodes; tiny forever-audience.

## Build plan (original — Phases 0–2 now mostly obsolete, see reassessment)

- **Phase 0 — probe app (a weekend):** throwaway APK dumping every
  InputDevice / KeyEvent / MotionEvent the Titan 2 emits (incl. Sym/Fn codes
  and whether keycap swipes surface). Answers go/no-go on feature 4 before
  any real investment.
- **Phase 1 — invisible IME (1–2 wks part-time):** pass-through typing +
  sticky Ctrl + Sym-layer arrows + Esc/Tab. Shippable on its own.
- **Phase 2:** settings screen, symbol layer, per-app profiles, autocorrect
  toggle.
- **Phase 3:** swipe features (if Phase 0 = yes) → Play + GitHub APK +
  Unihertz community post.

---

## 2026-08-15 reassessment: Pastiera already covers most of this

Source: github.com/palsoftware/pastiera — open-source Android IME "for
physical keyboards android devices (e.g. Unihertz Titan 2)", Android 10+.
Already installed as the daily keyboard (replaced stock Kika 2026-08-15).

**Verdict:** building Phases 0–2 would be reimplementing Pastiera in Kotlin
for a tiny audience. What survives as genuinely differentiated is narrow:

1. **Per-app / terminal-aware autocorrect profiles** (Pastiera: experimental,
   Shizuku-gated, no per-app system).
2. **Keycap-swipe cursor movement** — if the Titan 2 hardware even exposes
   raw keycap motion to an IME (still unprobed).
3. **Tight PersaLink integration.**

All three are better pursued as **contributions / feature requests to
Pastiera** (it's open source) than as a competing IME.

### Revised next steps

1. **Exploit Pastiera config now** — map Sym/Ctrl layers to get sticky Ctrl
   + arrows working today; no code needed.
2. **Still owed: input-debug-overlay screenshot** of pressing the Titan's
   special keys (Sym etc.). If the browser sees usable e.codes, bind
   Sym-layer arrows INSIDE PersaLink — immediate fix regardless of IME fate.
3. **After ~1 month of daily driving:** whatever pain Pastiera's config
   can't fix = the real feature list → first Pastiera PR (or, only if PRs
   are rejected/stalled, revive the standalone IME with that narrow scope).
