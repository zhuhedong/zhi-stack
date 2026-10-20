import {
  Children,
  isValidElement,
  useCallback,
  useId,
  useRef,
  useState,
  type ChangeEventHandler,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover } from './Popover';

interface Option {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function parse(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child) || child.type !== 'option') return [];
    const props = (child as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>)
      .props;
    const text = textOf(props.children);
    return [{ value: String(props.value ?? text), label: props.children, text, disabled: !!props.disabled }];
  });
}

/**
 * Drop-in replacement for <select> with a glass listbox. A real <select>
 * stays in the DOM (hidden on wide screens, shown at <=650px) so forms,
 * tests and mobile keep native behavior; picking from the listbox updates it
 * and fires a genuine change event, so `onChange={(e) => e.target.value}`
 * keeps working unchanged.
 */
export function Select({
  value,
  onChange,
  disabled,
  children,
  className = '',
  'aria-label': ariaLabel,
}: {
  value: string | number;
  onChange: ChangeEventHandler<HTMLSelectElement>;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  const options = parse(children);
  const current = String(value);
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const button = useRef<HTMLButtonElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const id = useId();
  const close = useCallback(() => setOpen(false), []);

  const enabledIndex = (from: number, step: number) => {
    for (let i = from, n = 0; n < options.length; i += step, n++) {
      const j = (i + options.length) % options.length;
      if (!options[j].disabled) return j;
    }
    return -1;
  };
  const show = (index = options.findIndex((o) => o.value === current)) => {
    if (disabled || window.matchMedia?.('(max-width: 650px)').matches) return;
    setActive(index >= 0 && !options[index]?.disabled ? index : enabledIndex(0, 1));
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    button.current?.focus();
    const el = native.current;
    if (!el || option.value === current) return;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, option.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const k = e.key;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (k === 'ArrowDown') setActive((i) => enabledIndex(i + 1, 1));
    else if (k === 'ArrowUp') setActive((i) => enabledIndex(i - 1, -1));
    else if (k === 'Home') setActive(enabledIndex(0, 1));
    else if (k === 'End') setActive(enabledIndex(options.length - 1, -1));
    else if (k === 'Enter' || k === ' ') choose(active);
    else if (k === 'Tab') return setOpen(false);
    else if (k.length === 1) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + k.toLowerCase(), at: now };
      const hit = options.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    } else return;
    e.preventDefault();
  };

  return (
    <span className={'ui-select ' + className}>
      <select
        ref={native}
        className="ui-select-native"
        tabIndex={-1}
        value={current}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={onChange}
      >
        {children}
      </select>
      <button
        ref={button}
        type="button"
        className="ui-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        <span className="ui-select-value">{selected?.label ?? ''}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <Popover anchor={button} open={open} onClose={close} className="ui-listbox" id={id} role="listbox" ariaLabel={ariaLabel}>
        {options.map((o, i) => (
          <div
            key={o.value + i}
            id={`${id}-${i}`}
            role="option"
            aria-selected={o.value === current}
            aria-disabled={o.disabled || undefined}
            className={'ui-option' + (i === active ? ' active' : '') + (o.value === current ? ' selected' : '')}
            onPointerEnter={() => !o.disabled && setActive(i)}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => choose(i)}
          >
            <span>{o.label}</span>
            {o.value === current && <Check size={12} aria-hidden="true" />}
          </div>
        ))}
      </Popover>
    </span>
  );
}
