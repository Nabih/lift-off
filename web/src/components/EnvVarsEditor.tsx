import { useState } from 'react';

interface Row {
  key: string;
  value: string;
}

interface Props {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

/**
 * Simple KEY=value editor for build-time environment variables. Kept as an
 * ordered list locally so typing a key character-by-character behaves, then
 * flattened into an object for the API.
 */
export default function EnvVarsEditor({ value, onChange }: Props) {
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(value).map(([key, val]) => ({ key, value: val })),
  );

  function commit(next: Row[]) {
    setRows(next);
    const flattened: Record<string, string> = {};
    for (const row of next) {
      const key = row.key.trim();
      if (key) flattened[key] = row.value;
    }
    onChange(flattened);
  }

  return (
    <div className="env-editor">
      {rows.length === 0 && (
        <p className="muted small">No environment variables.</p>
      )}

      {rows.map((row, index) => (
        <div className="env-row" key={index}>
          <input
            className="input mono"
            placeholder="VITE_API_URL"
            value={row.key}
            spellCheck={false}
            onChange={(event) =>
              commit(
                rows.map((item, i) =>
                  i === index ? { ...item, key: event.target.value } : item,
                ),
              )
            }
          />
          <input
            className="input mono"
            placeholder="https://api.example.com"
            value={row.value}
            spellCheck={false}
            onChange={(event) =>
              commit(
                rows.map((item, i) =>
                  i === index ? { ...item, value: event.target.value } : item,
                ),
              )
            }
          />
          <button
            type="button"
            className="btn ghost icon"
            title="Remove"
            onClick={() => commit(rows.filter((_, i) => i !== index))}
          >
            ✕
          </button>
        </div>
      ))}

      <button
        type="button"
        className="btn small"
        onClick={() => commit([...rows, { key: '', value: '' }])}
      >
        + Add variable
      </button>
    </div>
  );
}
