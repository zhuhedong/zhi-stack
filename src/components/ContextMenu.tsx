import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export type MenuCommand = {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
};

export function ContextMenu({
  x,
  y,
  commands,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  commands: MenuCommand[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
  }, [x, y, commands]);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label="快捷操作"
      style={{ left: x, top: y }}
    >
      {commands.map((command) => (
        <button
          key={command.id}
          type="button"
          role="menuitem"
          className={command.danger ? 'danger-text' : ''}
          disabled={command.disabled}
          onClick={() => onPick(command.id)}
        >
          {command.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
