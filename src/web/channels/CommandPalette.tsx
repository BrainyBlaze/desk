import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Command } from 'lucide-react';
import { ActionModal, useActionSounds } from './ActionModal.js';
import { fuzzyMatch } from './channelsModel.js';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  /** grouping label shown as a dim chip (e.g. Channel / Agent / Action) */
  group: string;
  run: () => void;
}

/**
 * Cmd-K command palette: fuzzy-jump to a channel / agent / action over the
 * data the channels subsystem already holds — zero new persistence, pure UI.
 * Matching is the unit-tested fuzzyMatch helper (no buried untested logic).
 */
export function CommandPalette({
  open,
  commands,
  onClose
}: {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sounds = useActionSounds();

  // Reset + focus when the palette opens.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    setQuery('');
    setActive(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const filtered = useMemo(
    () => commands.filter((command) => fuzzyMatch(query, `${command.label} ${command.hint ?? ''} ${command.group}`)),
    [commands, query]
  );

  // Keep the active index in range as the filter narrows.
  useEffect(() => {
    setActive((prev) => (prev >= filtered.length ? 0 : prev));
  }, [filtered.length]);

  if (!open) {
    return null;
  }

  const runAt = (index: number): void => {
    const command = filtered[index];
    if (command) {
      onClose();
      command.run();
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((prev) => (filtered.length === 0 ? 0 : (prev + 1) % filtered.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((prev) => (filtered.length === 0 ? 0 : (prev - 1 + filtered.length) % filtered.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runAt(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <ActionModal open={open} title="Command palette" icon={<Command size={13} />} onClose={onClose} wide>
      <input
        ref={inputRef}
        className="chanPaletteInput"
        placeholder="Jump to a channel, agent, or action..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Command palette search"
      />
      <ul className="chanPaletteList">
        {filtered.map((command, index) => (
          <li
            key={command.id}
            className={`chanPaletteItem ${index === active ? 'active' : ''}`}
            onMouseEnter={() => {
              sounds.hover();
              setActive(index);
            }}
            onClick={() =>
              sounds.click(() => {
                onClose();
                command.run();
              })
            }
          >
              <span className="chanPaletteGroup">{command.group}</span>
              <span className="chanPaletteLabel">{command.label}</span>
              {command.hint ? <span className="chanPaletteHint">{command.hint}</span> : null}
            </li>
          ))}
        {filtered.length === 0 ? <li className="chanPaletteEmpty">No matches</li> : null}
      </ul>
    </ActionModal>
  );
}
