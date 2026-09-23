import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown, Layers3, Search, X } from 'lucide-react';
import { Dialog } from 'radix-ui';

const RECENT_KEY = 'app-health:recent-project-ids:v1';
const MAX_RECENT = 5;

interface ProjectOption {
  appId: string;
  name: string;
}

interface Props {
  projects: ProjectOption[];
  selectedId: string | null;
  onSelect: (appId: string | null) => void;
}

interface OptionViewProps {
  listId: string;
  selectedId: string | null;
  activeIndex: number;
  onActivate: (index: number) => void;
  onSelect: (appId: string | null) => void;
}

function readRecentIds(): string[] {
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(stored)
      ? [...new Set(stored.filter((id): id is string => typeof id === 'string'))].slice(
          0,
          MAX_RECENT,
        )
      : [];
  } catch {
    return [];
  }
}

export function ProjectCommandPicker({ projects, selectedId, onSelect }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState(readRecentIds);
  const listId = useId();
  const titleId = useId();
  const authorized = new Map(projects.map((project) => [project.appId, project]));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(normalizedQuery);
  const showOverview = !normalizedQuery || matches('All projects') || matches('Overview');
  const recent = recentIds
    .map((id) => authorized.get(id))
    .filter((project): project is ProjectOption => Boolean(project))
    .filter((project) => matches(project.name));
  const recentSet = new Set(recent.map((project) => project.appId));
  const alphabetical = projects
    .filter((project) => !recentSet.has(project.appId) && matches(project.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const options = [
    ...(showOverview ? [{ appId: null, name: 'All projects' }] : []),
    ...recent,
    ...alphabetical,
  ];
  const selectedName = selectedId
    ? (authorized.get(selectedId)?.name ?? 'Project')
    : 'All projects';

  useEffect(() => {
    function onShortcut(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener('keydown', onShortcut);
    return () => document.removeEventListener('keydown', onShortcut);
  }, []);

  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${listId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, listId, activeIndex, query]);

  function changeOpen(next: boolean) {
    setOpen(next);
    setQuery('');
    setActiveIndex(0);
  }

  function select(appId: string | null) {
    if (appId) {
      const next = [appId, ...recentIds.filter((id) => id !== appId && authorized.has(id))].slice(
        0,
        MAX_RECENT,
      );
      setRecentIds(next);
      try {
        window.sessionStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // Navigation still works when session storage is unavailable.
      }
    }
    changeOpen(false);
    onSelect(appId);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      setActiveIndex((current) =>
        event.key === 'ArrowDown'
          ? (current + 1) % options.length
          : (current - 1 + options.length) % options.length,
      );
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : Math.max(options.length - 1, 0));
    } else if (event.key === 'Enter' && options[activeIndex]) {
      event.preventDefault();
      select(options[activeIndex].appId);
    }
  }

  const optionView = {
    listId,
    selectedId,
    activeIndex,
    onActivate: setActiveIndex,
    onSelect: select,
  };

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label="Project"
          aria-expanded={open}
          aria-haspopup="dialog"
          className="flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-xs shadow-xs outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring sm:w-52"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              changeOpen(true);
            }
          }}
        >
          <span className="min-w-0 flex-1 truncate">{selectedName}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          aria-labelledby={titleId}
          className="fixed top-[min(20vh,9rem)] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl outline-none"
        >
          <Dialog.Title id={titleId} className="sr-only">
            Find a project
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Search your projects, use arrow keys to move, and press Enter to select.
          </Dialog.Description>
          <div className="flex h-14 items-center gap-3 border-b px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-label="Search projects"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={
                options[activeIndex] ? `${listId}-option-${activeIndex}` : undefined
              }
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder="Search projects…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
            />
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close project picker"
                className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Projects"
            className="max-h-[min(55vh,26rem)] overflow-y-auto p-2"
          >
            {showOverview ? (
              <div className="border-b pb-2">
                <PickerOption
                  option={{ appId: null, name: 'All projects' }}
                  index={0}
                  {...optionView}
                />
              </div>
            ) : null}
            {recent.length > 0 ? (
              <PickerOptionGroup
                label="Recent"
                options={recent}
                startIndex={showOverview ? 1 : 0}
                {...optionView}
              />
            ) : null}
            {alphabetical.length > 0 ? (
              <PickerOptionGroup
                label="Projects"
                options={alphabetical}
                startIndex={(showOverview ? 1 : 0) + recent.length}
                {...optionView}
              />
            ) : null}
            {options.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground" role="status">
                No projects found
              </p>
            ) : null}
          </div>
          <div className="hidden items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground sm:flex">
            <span>↑↓ navigate · enter select · esc close</span>
            <span>⌘K / Ctrl K to open</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PickerOption({
  option,
  index,
  listId,
  selectedId,
  activeIndex,
  onActivate,
  onSelect,
}: OptionViewProps & {
  option: { appId: string | null; name: string };
  index: number;
}): JSX.Element {
  const selected = selectedId === option.appId;
  return (
    <button
      id={`${listId}-option-${index}`}
      type="button"
      role="option"
      aria-selected={selected}
      className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
      data-active={activeIndex === index}
      onMouseEnter={() => onActivate(index)}
      onClick={() => onSelect(option.appId)}
    >
      {option.appId === null ? <Layers3 className="size-4 shrink-0 text-muted-foreground" /> : null}
      <span className="min-w-0 flex-1 truncate">{option.name}</span>
      {selected ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
    </button>
  );
}

function PickerOptionGroup({
  label,
  options,
  startIndex,
  ...optionView
}: OptionViewProps & {
  label: string;
  options: ProjectOption[];
  startIndex: number;
}): JSX.Element {
  return (
    <div className="pt-2">
      <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {options.map((option, index) => (
        <PickerOption
          key={option.appId}
          option={option}
          index={startIndex + index}
          {...optionView}
        />
      ))}
    </div>
  );
}
