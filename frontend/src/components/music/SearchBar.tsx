import { useState, useRef } from 'preact/hooks';

interface SearchBarProps {
  onSearch: (query: string) => void;
  onClear: () => void;
  loading?: boolean;
  resultCount?: number | null;
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function SearchBar({ onSearch, onClear, loading, resultCount }: SearchBarProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function handleInput(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    setValue(val);
    onSearch(val);
  }

  function handleClear() {
    setValue('');
    onClear();
    inputRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      handleClear();
    }
  }

  return (
    <div class="music-search">
      <div class="music-search__input-wrap">
        <span class="music-search__icon">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          type="text"
          class="music-search__input"
          placeholder="Search artists, albums, tracks..."
          value={value}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
        />
        {loading && (
          <span class="music-search__spinner animate-spin">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
            </svg>
          </span>
        )}
        {value && (
          <button class="music-search__clear" onClick={handleClear} aria-label="Clear search">
            <ClearIcon />
          </button>
        )}
      </div>
      {resultCount !== null && resultCount !== undefined && value && (
        <div class="music-search__count text-sm text-secondary">
          {resultCount} result{resultCount !== 1 ? 's' : ''} found
        </div>
      )}
    </div>
  );
}
