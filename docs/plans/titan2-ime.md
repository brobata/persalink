# Titan 2 IME — parked plan (2026-08-15)

A custom Android keyboard (IME) for the Unihertz Titan 2 / 2 Elite. Parked in
favor of shipping PersaLink to the Play Store first. Revisit after a month of
daily Titan use — by then the must-have list will be obvious.

## Why

- The Titan community hand-rolled IMEs for the old Titan Pocket
  (titanpocketkeyboard, PocketBoard, TitanPad) — proven demand, and **nobody
  has built one for the Titan 2 generation yet** (first-mover gap).
- An IME fixes typing once, system-wide, instead of per-app key bars.
- Perfect complement to PersaLink: IME owns typing, PersaLink owns sessions.
  Each markets the other to the same few thousand keyboard-phone nerds.

## Feature set (pain-ranked)

1. Real modifiers: sticky Ctrl (Sym then C = Ctrl+C anywhere), Esc, Tab,
   arrows on a layer (hold-Sym → WASD = ↑←↓→).
2. Dev-sane symbol layer (| ~ ` {} predictable).
3. Autocorrect that knows its place — off in terminals, per-app profiles.
4. Swipe-on-keycaps cursor movement (SPECULATIVE — see risk).
5. Long-press alternates, clipboard strip, emoji search.

## Risk map

- Key events (1–3): LOW — physical presses are standard KeyEvents; the
  Pocket IMEs prove the pattern.
- Keycap touch surface (4): UNKNOWN on Titan 2 — Unihertz's Scroll Assistant
  consumes swipes at system level; whether an IME still sees raw motion
  events on this generation is the go/no-go question. PocketBoard proved it
  readable on the Pocket.
- Native Kotlin only (InputMethodService) — no Expo/RN path. Dev loop =
  sideload debug APKs on the Titan via adb.
- Maintenance: firmware updates can shuffle keycodes; tiny forever-audience.

## Build plan (de-risked)

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

## Cheap precursor (do first, no IME needed)

User owes an input-debug-overlay screenshot of pressing the Titan's special
keys (Sym etc.). If the browser sees usable e.codes, bind Sym-layer arrows
INSIDE PersaLink — immediate fix + proof-of-demand for the IME.
