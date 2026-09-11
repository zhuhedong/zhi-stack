import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  role = 'dialog',
  descriptionId,
  initialFocusRef,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  role?: 'dialog' | 'alertdialog';
  descriptionId?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    const focus =
      initialFocusRef?.current ?? dialog?.querySelector<HTMLElement>('input:not([type=hidden]),textarea');
    focus?.focus();
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [initialFocusRef]);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''} ${className}`}
      role={role}
      aria-modal="true"
      aria-label={title}
      aria-describedby={descriptionId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
