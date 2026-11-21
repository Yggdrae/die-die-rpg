import { useEffect, useId, useRef, useState } from 'react';
import { type PaletteEntry, type PaletteProvider, paletteResults } from './session-model.ts';

/**
 * D-12: `Ctrl + K` palette. It runs registered operations, not only navigation (`PRD.md` s.45): arrows move, Enter
 * runs, Escape closes, and the session screen stays where it was.
 */
export function CommandPalette(props: {
  readonly entries: readonly PaletteEntry[];
  readonly providers?: readonly PaletteProvider[];
  readonly onRun: (entry: PaletteEntry) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = paletteResults(props.entries, query, props.providers);
  const current = results[Math.min(active, Math.max(results.length - 1, 0))];

  useEffect(() => {
    input.current?.focus();
  }, []);

  const run = (entry: PaletteEntry | undefined) => {
    if (entry === undefined) return;
    props.onClose();
    props.onRun(entry);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Command palette">
      <input
        ref={input}
        aria-label="Command"
        aria-controls={listId}
        placeholder="Type an action, a scene, a name…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            props.onClose();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, results.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            run(current);
          }
        }}
      />
      <ul id={listId} aria-label="Results">
        {results.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              aria-current={entry === current ? 'true' : undefined}
              onClick={() => run(entry)}
            >
              {entry.label}
            </button>{' '}
            <small>{entry.group}</small>
          </li>
        ))}
        {results.length === 0 && <li>Nothing matches.</li>}
      </ul>
    </div>
  );
}
