import { useState, useCallback } from 'preact/hooks';
import type { MusicRandomItem } from '../../api/types';
import type { SyncSelection } from './SyncQueue';

interface RandomModeProps {
  onGetRandom: (count: number, type: string) => Promise<MusicRandomItem[] | null>;
  syncQueue: Map<string, SyncSelection>;
  onToggleSelection: (path: string, selection: SyncSelection) => void;
  onStartSync: (mode: string, paths: string[], count: number, type: string) => Promise<unknown>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function DiceIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="3" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <circle cx="16" cy="8" r="1.5" fill="currentColor" />
      <circle cx="8" cy="16" r="1.5" fill="currentColor" />
      <circle cx="16" cy="16" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

const COUNT_OPTIONS = [5, 10, 20, 50];

export function RandomMode({ onGetRandom, syncQueue, onToggleSelection, onStartSync }: RandomModeProps) {
  const [count, setCount] = useState(20);
  const [itemType, setItemType] = useState<'artist' | 'album'>('artist');
  const [items, setItems] = useState<MusicRandomItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState(false);

  const handlePick = useCallback(async () => {
    setLoading(true);
    try {
      const result = await onGetRandom(count, itemType);
      if (result) {
        setItems(result);
        setPicked(true);
      }
    } finally {
      setLoading(false);
    }
  }, [count, itemType, onGetRandom]);

  const handleToggle = useCallback((item: MusicRandomItem) => {
    const path = item.album ? `/${item.artist}/${item.album}` : `/${item.artist}`;
    const label = item.album ? `${item.artist} - ${item.album}` : item.artist;
    const sel: SyncSelection = {
      path,
      label,
      type: item.album ? 'album' : 'artist',
      trackCount: item.track_count,
      totalSize: item.total_size,
    };
    onToggleSelection(path, sel);
  }, [onToggleSelection]);

  const handleSyncDirect = useCallback(async () => {
    // Add all visible items to queue first, then sync
    const paths = items.map((item) =>
      item.album ? `/${item.artist}/${item.album}` : `/${item.artist}`
    );
    await onStartSync('random', paths, count, itemType);
  }, [items, count, itemType, onStartSync]);

  const totalSize = items.reduce((sum, item) => sum + item.total_size, 0);

  return (
    <div class="random-mode">
      {/* Controls */}
      <div class="random-mode__controls">
        <div class="random-mode__row">
          <label class="random-mode__label text-sm">Type</label>
          <div class="random-mode__toggle-group">
            <button
              class={`random-mode__toggle ${itemType === 'artist' ? 'random-mode__toggle--active' : ''}`}
              onClick={() => setItemType('artist')}
            >
              Artists
            </button>
            <button
              class={`random-mode__toggle ${itemType === 'album' ? 'random-mode__toggle--active' : ''}`}
              onClick={() => setItemType('album')}
            >
              Albums
            </button>
          </div>
        </div>

        <div class="random-mode__row">
          <label class="random-mode__label text-sm">Count</label>
          <div class="random-mode__toggle-group">
            {COUNT_OPTIONS.map((n) => (
              <button
                key={n}
                class={`random-mode__toggle ${count === n ? 'random-mode__toggle--active' : ''}`}
                onClick={() => setCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div class="random-mode__actions">
          <button
            class="btn btn--primary"
            onClick={handlePick}
            disabled={loading}
          >
            <DiceIcon />
            <span style={{ marginLeft: 'var(--space-2)' }}>
              {loading ? 'Picking...' : picked ? 'Reshuffle' : 'Pick Random'}
            </span>
          </button>
        </div>
      </div>

      {/* Results */}
      {items.length > 0 && (
        <div class="random-mode__results">
          <div class="random-mode__results-header">
            <span class="text-sm text-secondary">
              {items.length} {itemType}s selected -- {formatBytes(totalSize)}
            </span>
            <button class="btn btn--accent btn--sm" onClick={handleSyncDirect}>
              Sync These Now
            </button>
          </div>

          <div class="random-mode__list">
            {items.map((item) => {
              const path = item.album ? `/${item.artist}/${item.album}` : `/${item.artist}`;
              const isSelected = syncQueue.has(path);
              return (
                <div
                  key={path}
                  class={`random-mode__item ${isSelected ? 'random-mode__item--selected' : ''}`}
                >
                  <label class="random-mode__checkbox">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => handleToggle(item)}
                    />
                  </label>
                  <div class="random-mode__item-info">
                    <div class="random-mode__item-name truncate">
                      {item.album ? `${item.artist} - ${item.album}` : item.artist}
                    </div>
                    <div class="text-xs text-muted">
                      {item.album_count != null && `${item.album_count} albums · `}
                      {item.track_count} tracks -- {formatBytes(item.total_size)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!picked && !loading && (
        <div class="random-mode__empty">
          <DiceIcon />
          <p class="text-sm text-secondary" style={{ marginTop: 'var(--space-3)' }}>
            Pick random {itemType}s to discover something new
          </p>
        </div>
      )}
    </div>
  );
}
