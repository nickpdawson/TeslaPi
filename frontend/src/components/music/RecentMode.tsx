import { useState, useEffect, useCallback } from 'preact/hooks';
import type { MusicRecentItem } from '../../api/types';
import type { SyncSelection } from './SyncQueue';

interface RecentModeProps {
  onGetRecent: (count: number) => Promise<MusicRecentItem[] | null>;
  syncQueue: Map<string, SyncSelection>;
  onToggleSelection: (path: string, selection: SyncSelection) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return date.toLocaleDateString();
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

const COUNT_OPTIONS = [20, 50, 100];

export function RecentMode({ onGetRecent, syncQueue, onToggleSelection }: RecentModeProps) {
  const [count, setCount] = useState(50);
  const [items, setItems] = useState<MusicRecentItem[]>([]);
  const [loading, setLoading] = useState(false);

  const loadItems = useCallback(async (n: number) => {
    setLoading(true);
    try {
      const result = await onGetRecent(n);
      if (result) {
        setItems(result);
      }
    } finally {
      setLoading(false);
    }
  }, [onGetRecent]);

  useEffect(() => {
    loadItems(count);
  }, [count]);

  const handleToggle = useCallback((item: MusicRecentItem) => {
    const path = `/${item.artist}/${item.album}`;
    const sel: SyncSelection = {
      path,
      label: `${item.artist} - ${item.album}`,
      type: 'album',
      trackCount: item.track_count,
      totalSize: item.total_size,
    };
    onToggleSelection(path, sel);
  }, [onToggleSelection]);

  return (
    <div class="recent-mode">
      {/* Count selector */}
      <div class="recent-mode__controls">
        <span class="text-sm text-secondary">Show last</span>
        <div class="recent-mode__toggle-group">
          {COUNT_OPTIONS.map((n) => (
            <button
              key={n}
              class={`recent-mode__toggle ${count === n ? 'recent-mode__toggle--active' : ''}`}
              onClick={() => setCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <span class="text-sm text-secondary">additions</span>
      </div>

      {/* Items list */}
      <div class="recent-mode__list">
        {loading && items.length === 0 && (
          <div class="recent-mode__loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} class="skeleton" style={{ height: '52px', marginBottom: 'var(--space-2)', borderRadius: 'var(--radius-sm)' }} />
            ))}
          </div>
        )}

        {!loading && items.length === 0 && (
          <div class="recent-mode__empty">
            <ClockIcon />
            <p class="text-sm text-secondary" style={{ marginTop: 'var(--space-2)' }}>
              No items found. Index the library first.
            </p>
          </div>
        )}

        {items.map((item) => {
          const path = `/${item.artist}/${item.album}`;
          const isSelected = syncQueue.has(path);
          return (
            <div
              key={path}
              class={`recent-mode__item ${isSelected ? 'recent-mode__item--selected' : ''}`}
            >
              <label class="recent-mode__checkbox">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => handleToggle(item)}
                />
              </label>
              <div class="recent-mode__item-info">
                <div class="recent-mode__item-name truncate">
                  {item.artist} - {item.album}
                </div>
                <div class="text-xs text-muted">
                  {item.track_count} tracks -- {formatBytes(item.total_size)} -- {formatDate(item.latest_modified)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
