import { useId, useMemo, useState } from 'react';

/** Case-insensitive fuzzy rank: substring beats in-order subsequence; null = no match. */
export function projectMatchScore(name: string, query: string): number | null {
  const n = name.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const at = n.indexOf(q);
  if (at >= 0) return at === 0 ? 0 : 1 + at / 100;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 3 : null;
}
export function matchProjects(names: string[], query: string, limit = 8): string[] {
  return names
    .map((name) => ({ name, score: projectMatchScore(name, query) }))
    .filter((m): m is { name: string; score: number } => m.score !== null)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, limit)
    .map((m) => m.name);
}

/** Text field with fuzzy project suggestions; free text still creates a new project name. */
export function ProjectInput({
  value,
  projects,
  onChange,
  disabled,
  placeholder = '选择或输入项目名称',
}: {
  value: string;
  projects: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const options = useMemo(
    () => matchProjects(projects, value).filter((name) => name !== value),
    [projects, value],
  );
  const show = open && options.length > 0;
  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };
  return (
    <span className="project-input">
      <input
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setActive((i) => (i + step + options.length) % options.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(options[active] ?? options[0]);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {show && (
        <ul className="project-options" id={listId} role="listbox">
          {options.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              // mousedown keeps focus so blur doesn't close before the pick.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(name);
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
