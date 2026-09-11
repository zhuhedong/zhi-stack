import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { ConfirmationContext, type ConfirmationOptions, type ConfirmHandler } from '../lib/confirmation';
import { Modal } from './Modal';

interface PendingConfirmation {
  id: number;
  options: ConfirmationOptions;
  signal: AbortSignal;
  cancel: () => void;
  resolve: (accepted: boolean) => void;
}

function ConfirmationDialog({
  request,
  onAnswer,
}: {
  request: PendingConfirmation;
  onAnswer: (accepted: boolean) => void;
}) {
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { title, description, confirmLabel, cancelLabel = '取消', danger = false } = request.options;
  return (
    <Modal
      title={title}
      role="alertdialog"
      descriptionId={descriptionId}
      initialFocusRef={cancelRef}
      className="confirmation-modal"
      onClose={() => onAnswer(false)}
    >
      <div className={`modal-body confirmation-body${danger ? ' confirmation-danger' : ''}`}>
        <CircleAlert size={22} aria-hidden="true" />
        <p id={descriptionId}>{description}</p>
      </div>
      <div className="modal-foot">
        <button ref={cancelRef} type="button" onClick={() => onAnswer(false)}>
          {cancelLabel}
        </button>
        <button type="button" className={danger ? 'danger' : 'primary'} onClick={() => onAnswer(true)}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const queue = useRef<PendingConfirmation[]>([]);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const [current, setCurrent] = useState<PendingConfirmation | null>(null);
  const finish = useCallback((id: number, accepted: boolean) => {
    const index = queue.current.findIndex((request) => request.id === id);
    if (index === -1) return;
    const [request] = queue.current.splice(index, 1);
    request.signal.removeEventListener('abort', request.cancel);
    request.resolve(accepted);
    if (mounted.current) setCurrent(queue.current[0] ?? null);
  }, []);
  const request = useCallback<ConfirmHandler>(
    (options, signal) => {
      if (!mounted.current || signal.aborted) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const id = ++sequence.current;
        const pending: PendingConfirmation = {
          id,
          options,
          signal,
          resolve,
          cancel: () => finish(id, false),
        };
        signal.addEventListener('abort', pending.cancel, { once: true });
        queue.current.push(pending);
        if (queue.current.length === 1) setCurrent(pending);
      });
    },
    [finish],
  );
  useEffect(() => {
    mounted.current = true;
    const pending = queue.current;
    return () => {
      mounted.current = false;
      for (const request of pending.splice(0)) {
        request.signal.removeEventListener('abort', request.cancel);
        request.resolve(false);
      }
    };
  }, []);
  return (
    <ConfirmationContext.Provider value={request}>
      {children}
      {current && (
        <ConfirmationDialog
          key={current.id}
          request={current}
          onAnswer={(accepted) => finish(current.id, accepted)}
        />
      )}
    </ConfirmationContext.Provider>
  );
}
