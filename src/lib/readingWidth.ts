import { useEffect, useState } from 'react';

export type ReadingWidth = 'narrow' | 'standard' | 'wide';
const KEY = 'infohub.readingWidth';
const valid = (v: unknown): v is ReadingWidth => v === 'narrow' || v === 'standard' || v === 'wide';

function read(): ReadingWidth {
  try {
    const v = localStorage.getItem(KEY);
    return valid(v) ? v : 'standard';
  } catch {
    return 'standard';
  }
}

/** Applies the reading width preference as `data-reading-width` on <html>. */
export function applyReadingWidth(value: ReadingWidth = read()) {
  document.documentElement.dataset.readingWidth = value;
}

export function useReadingWidth() {
  const [width, setWidth] = useState<ReadingWidth>(read);
  useEffect(() => {
    applyReadingWidth(width);
    try {
      localStorage.setItem(KEY, width);
    } catch {
      /* storage unavailable: keep in memory only */
    }
  }, [width]);
  return [width, setWidth] as const;
}
