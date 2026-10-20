import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { Popover } from './ui/Popover';

export interface FilterTab {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * Horizontal category tabs: scrolls sideways (wheel converts to horizontal),
 * shows fade masks on overflowing edges, keeps the selected tab in view and
 * offers a "更多" menu listing tabs that are not fully visible.
 */
export function FilterTabs({
  tabs,
  value,
  onChange,
  label = '分类筛选',
}: {
  tabs: FilterTab[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState<'' | 'start' | 'end' | 'both'>('');
  const [hidden, setHidden] = useState<string[]>([]);
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);

  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow(start && end ? 'both' : start ? 'start' : end ? 'end' : '');
    const box = el.getBoundingClientRect();
    setHidden(
      [...el.querySelectorAll<HTMLButtonElement>('[role=tab]')]
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.left < box.left - 1 || r.right > box.right + 1;
        })
        .map((b) => b.dataset.value || ''),
    );
  }, []);

  useLayoutEffect(measure, [measure, tabs]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('scroll', measure);
    };
  }, [measure]);
  useEffect(() => {
    const box = strip.current;
    const el = box?.querySelector<HTMLElement>('[aria-selected=true]');
    if (!box || !el) return;
    // Center the selected tab so it never sits under an edge fade.
    const left = el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2;
    box.scrollTo?.({ left: Math.max(0, left) });
  }, [value]);

  const enabled = tabs.filter((t) => !t.disabled);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = enabled.findIndex((t) => t.value === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else return;
    e.preventDefault();
    const t = enabled[next];
    if (!t) return;
    onChange(t.value);
    requestAnimationFrame(() =>
      strip.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(t.value)}"]`)?.focus(),
    );
  };
  const hiddenTabs = tabs.filter((t) => hidden.includes(t.value));

  return (
    <div className="filter-tabs" data-overflow={overflow || undefined}>
      <div ref={strip} className="list-filter" role="tablist" aria-label={label} onKeyDown={onKey}>
        {tabs.map((t) => (
          <button
            key={t.value}
            role="tab"
            data-value={t.value}
            aria-selected={t.value === value}
            tabIndex={t.value === value ? 0 : -1}
            disabled={t.disabled}
            className={t.value === value ? 'selected' : ''}
            onClick={() => onChange(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {hiddenTabs.length > 0 && (
        <button
          ref={more}
          type="button"
          className="filter-more"
          aria-haspopup="menu"
          aria-expanded={menu}
          title="更多分类"
          onClick={() => setMenu((v) => !v)}
        >
          更多
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      )}
      <Popover anchor={more} open={menu} onClose={closeMenu} matchWidth={false} role="menu" ariaLabel="更多分类">
        {hiddenTabs.map((t) => (
          <div
            key={t.value}
            role="menuitemradio"
            aria-checked={t.value === value}
            aria-disabled={t.disabled || undefined}
            tabIndex={-1}
            className={'ui-option' + (t.value === value ? ' selected' : '')}
            onClick={() => {
              if (t.disabled) return;
              onChange(t.value);
              setMenu(false);
            }}
          >
            {t.label}
          </div>
        ))}
      </Popover>
    </div>
  );
}
