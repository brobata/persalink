/**
 * @file HeroIcon
 * @description The mark at the top of a pre-auth screen (sign-in, lock,
 *   add a server): one lucide icon in a quiet raised tile. Replaces the old
 *   emoji, so those screens read as the same product as the rest.
 */

import type { LucideIcon } from 'lucide-react';

export function HeroIcon({ icon: Icon, className = '' }: { icon: LucideIcon; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-grid place-items-center w-14 h-14 rounded-[14px] bg-bg-2 border border-line-2 text-accent-hi ${className}`}
    >
      <Icon className="w-6 h-6" strokeWidth={1.75} />
    </span>
  );
}
