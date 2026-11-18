/**
 * @file IconButton
 * @description The one icon-only button: 44px square on touch screens,
 *   32px on desktop (the --pl-touch token), neutral until pressed. Always
 *   carries a spoken label, which is also its tooltip.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Spoken name and tooltip ("Search sessions", "Close"). */
  label: string;
  children: ReactNode;
  /** A toggle that is on (drawn pressed). */
  pressed?: boolean;
  size?: 'touch' | 'xs';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, pressed, size = 'touch', className = '', type = 'button', title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      className={`pl-ib${size === 'xs' ? ' xs' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
