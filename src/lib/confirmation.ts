import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

export interface ConfirmationOptions {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}
export type ConfirmHandler = (options: ConfirmationOptions, signal: AbortSignal) => Promise<boolean>;
export const ConfirmationContext = createContext<ConfirmHandler | null>(null);

export function useConfirm(scope?: string | boolean) {
  const request = useContext(ConfirmationContext);
  if (!request) throw new Error('useConfirm requires ConfirmationProvider');
  const owner = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    return () => controller.abort();
  }, [scope]);
  return useCallback(
    (options: ConfirmationOptions) => request(options, owner.current?.signal ?? AbortSignal.abort()),
    [request],
  );
}
