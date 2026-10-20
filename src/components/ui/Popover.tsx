import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * Floating glass panel anchored to an element. Rendered into the anchor's
 * closest <dialog> (top layer) or <body>, flips above when there is no room
 * below, and closes on outside pointer, Escape, scroll and resize.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  className = '',
  matchWidth = true,
  id,
  role,
  ariaLabel,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  matchWidth?: boolean;
  id?: string;
  role?: string;
  ariaLabel?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const h = panel.current?.offsetHeight || 240;
    const up = r.bottom + h + 8 > window.innerHeight && r.top > h + 8;
    const width = Math.max(r.width, matchWidth ? r.width : 160);
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8));
    setPos({ top: up ? r.top - h - 4 : r.bottom + 4, left, width, up });
  }, [open, anchor, matchWidth]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
        anchor.current?.focus();
      }
    };
    const scroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, onClose, anchor]);
  if (!open) return null;
  const host = anchor.current?.closest('dialog') || document.body;
  return createPortal(
    <div
      ref={panel}
      id={id}
      role={role}
      aria-label={ariaLabel}
      className={'popover ' + className + (pos?.up ? ' up' : '')}
      style={
        pos
          ? { top: pos.top, left: pos.left, minWidth: pos.width }
          : { top: -9999, left: -9999, visibility: 'hidden' }
      }
    >
      {children}
    </div>,
    host,
  );
}
