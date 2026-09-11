import { useEffect, useRef, useState } from 'react';

// Saving a snapshot must not mark edits made during the request as saved.
export function useDraft(onDirty: (dirty: boolean) => void) {
  const [dirty, setDirty] = useState(false);
  const version = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return {
    dirty,
    change() {
      version.current++;
      setDirty(true);
      onDirty(true);
    },
    snapshot: () => version.current,
    saved(snapshot: number) {
      if (!active.current) return false;
      const changed = snapshot !== version.current;
      setDirty(changed);
      onDirty(changed);
      return true;
    },
  };
}
