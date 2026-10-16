import { useState } from 'react';

export interface CheckboxOption {
  id: string;
  label: string;
}

interface Props {
  options: CheckboxOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  filterPlaceholder?: string;
  /** Shown instead of the list when there is nothing to assign at all. */
  emptyMessage?: string;
}

/**
 * A multi-select checkbox grid with a filter box. Used for both directions of
 * site access: picking a user's sites, and picking a site's users.
 */
export default function CheckboxList({
  options,
  selected,
  onChange,
  filterPlaceholder = 'Filter…',
  emptyMessage = 'Nothing to assign yet.',
}: Props) {
  const [filter, setFilter] = useState('');

  if (options.length === 0) {
    return <p className="muted small">{emptyMessage}</p>;
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options;

  function toggle(id: string, checked: boolean) {
    onChange(
      checked
        ? [...selected, id]
        : selected.filter((value) => value !== id),
    );
  }

  return (
    <div className="checkbox-list">
      <input
        className="input"
        value={filter}
        placeholder={filterPlaceholder}
        aria-label={filterPlaceholder}
        onChange={(event) => setFilter(event.target.value)}
      />

      {shown.length === 0 ? (
        <p className="muted small">No matches for “{filter.trim()}”.</p>
      ) : (
        <div className="checkbox-grid">
          {shown.map((option) => (
            <label className="checkbox" key={option.id}>
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={(event) => toggle(option.id, event.target.checked)}
              />
              {option.label}
            </label>
          ))}
        </div>
      )}

      <span className="hint">
        {selected.length} of {options.length} selected
      </span>
    </div>
  );
}
