import { useState, useEffect, useCallback } from 'preact/hooks';
import type { MusicBrowseItem, MusicBrowseResponse } from '../../api/types';
import type { SyncSelection } from './SyncQueue';

interface BrowseModeProps {
  onBrowse: (path: string, offset?: number, limit?: number) => Promise<MusicBrowseResponse | null>;
  syncQueue: Map<string, SyncSelection>;
  onToggleSelection: (path: string, selection: SyncSelection) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

export function BrowseMode({ onBrowse, syncQueue, onToggleSelection }: BrowseModeProps) {
  const [currentPath, setCurrentPath] = useState('/');
  const [items, setItems] = useState<MusicBrowseItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadPath = useCallback(async (path: string, pageOffset = 0) => {
    setLoading(true);
    try {
      const result = await onBrowse(path, pageOffset, 200);
      if (result) {
        if (pageOffset === 0) {
          setItems(result.items);
        } else {
          setItems((prev) => [...prev, ...result.items]);
        }
        setTotal(result.total);
        setOffset(pageOffset);
        setHasMore(result.hasMore);
        if (pageOffset === 0) {
          setCurrentPath(path);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [onBrowse]);

  useEffect(() => {
    loadPath('/');
  }, []);

  const handleNavigate = useCallback((path: string) => {
    loadPath(path);
  }, [loadPath]);

  const handleLoadMore = useCallback(() => {
    if (!loading && hasMore) {
      loadPath(currentPath, offset + 200);
    }
  }, [loading, hasMore, currentPath, offset, loadPath]);

  const handleToggle = useCallback((item: MusicBrowseItem) => {
    const parts = item.path.split('/').filter(Boolean);
    const itemType = parts.length <= 1 ? 'artist' : 'album';
    const sel: SyncSelection = {
      path: item.path,
      label: parts.length <= 1 ? item.name : `${parts[0]} - ${item.name}`,
      type: itemType,
      trackCount: 0, // Unknown from browse
      totalSize: item.size,
    };
    onToggleSelection(item.path, sel);
  }, [onToggleSelection]);

  // Build breadcrumbs
  const pathParts = currentPath.split('/').filter(Boolean);
  const breadcrumbs = [{ label: 'Root', path: '/' }];
  for (let i = 0; i < pathParts.length; i++) {
    breadcrumbs.push({
      label: pathParts[i],
      path: '/' + pathParts.slice(0, i + 1).join('/'),
    });
  }

  return (
    <div class="browse-mode">
      {/* Breadcrumb */}
      <div class="browse-mode__breadcrumb">
        {breadcrumbs.map((bc, i) => (
          <span key={bc.path}>
            {i > 0 && <span class="browse-mode__breadcrumb-sep">/</span>}
            {i === breadcrumbs.length - 1 ? (
              <span class="browse-mode__breadcrumb-current">{bc.label}</span>
            ) : (
              <button
                class="browse-mode__breadcrumb-link"
                onClick={() => handleNavigate(bc.path)}
              >
                {bc.label}
              </button>
            )}
          </span>
        ))}
        {total > 0 && (
          <span class="browse-mode__count text-xs text-muted">
            ({total.toLocaleString()} items)
          </span>
        )}
      </div>

      {/* Item list */}
      <div class="browse-mode__list">
        {items.map((item) => {
          const isSelected = syncQueue.has(item.path);
          return (
            <div
              key={item.path}
              class={`browse-mode__item ${isSelected ? 'browse-mode__item--selected' : ''}`}
            >
              {item.isDirectory && (
                <label class="browse-mode__checkbox">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => handleToggle(item)}
                  />
                </label>
              )}
              <button
                class="browse-mode__item-btn"
                onClick={() => item.isDirectory ? handleNavigate(item.path) : undefined}
                disabled={!item.isDirectory}
              >
                <span class="browse-mode__item-icon">
                  {item.isDirectory ? <FolderIcon /> : <FileIcon />}
                </span>
                <span class="browse-mode__item-name truncate">{item.name}</span>
              </button>
              {item.size > 0 && (
                <span class="browse-mode__item-size text-xs text-muted">
                  {formatBytes(item.size)}
                </span>
              )}
            </div>
          );
        })}

        {loading && (
          <div class="browse-mode__loading text-sm text-muted">
            Loading...
          </div>
        )}

        {!loading && items.length === 0 && (
          <div class="browse-mode__empty text-sm text-muted">
            No items found
          </div>
        )}

        {hasMore && !loading && (
          <button class="browse-mode__load-more btn btn--ghost btn--sm" onClick={handleLoadMore}>
            Load more ({total - items.length} remaining)
          </button>
        )}
      </div>
    </div>
  );
}
