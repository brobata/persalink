/**
 * @file Device rhythm classes
 * @description Sets html.pl-phone / html.pl-desktop / html.pl-square from the
 *   viewport, the same rule the design prototypes use. Phone = under 768px
 *   wide. Square = a phone whose screen is roughly square and short (the
 *   Titan 2, ~412x412 screen): it runs the phone layout with a tighter rhythm
 *   (header 44, dock 48, chips 40), set through CSS variables in
 *   styles/index.css. Nothing here detects a hardware keyboard; no layout
 *   depends on one.
 */

export type DeviceKind = 'phone' | 'desktop';

export function deviceKind(w = window.innerWidth): DeviceKind {
  return w < 768 ? 'phone' : 'desktop';
}

/**
 * Judged on the screen, not the window: a tall phone with its soft keyboard
 * up has a short, nearly square window (~390x500), and must keep the tall
 * rhythm. The screen does not change when the keyboard opens.
 */
export function isSquare(w = window.innerWidth, sw = window.screen?.width ?? w, sh = window.screen?.height ?? w): boolean {
  const long = Math.max(sw, sh);
  const short = Math.max(1, Math.min(sw, sh));
  return w < 768 && long <= 600 && long / short < 1.35;
}

function apply(): void {
  const c = document.documentElement.classList;
  const d = deviceKind();
  c.toggle('pl-phone', d === 'phone');
  c.toggle('pl-desktop', d === 'desktop');
  c.toggle('pl-square', isSquare());
}

let installed = false;

/** Apply the classes now and keep them current on resize and rotation. */
export function installDeviceClasses(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  apply();
  window.addEventListener('resize', apply, { passive: true });
  window.visualViewport?.addEventListener('resize', apply, { passive: true });
}
