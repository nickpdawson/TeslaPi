import { useState, useEffect, useCallback } from 'preact/hooks';
import { get, post } from '../../api/client';
import { SyncProgress } from './SyncProgress';
import type { MusicSyncJob } from '../../api/types';

interface BrowseItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

interface LibraryTabProps {
  syncJob: MusicSyncJob | null;
  syncActive: boolean;
  onCancelSync: () => void;
  onFetchLocalMusic: () => Promise<unknown>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function LibraryTab({ syncJob, syncActive, onCancelSync, onFetchLocalMusic }: LibraryTabProps) {
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [currentPath, setCurrentPath] = useState('/');
  const [breadcrumbs, setBreadcrumbs] = useState<{ name: string; path: string }[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const fetchItems = useCallback(async (path: string, append = false, search = '') => {
    setLoading(true);
    setError(null);
    const fetchOffset = append ? offset : 0;
    try {
      let url = `/music/library/browse?path=${encodeURIComponent(path)}&offset=${fetchOffset}&limit=200`;
      if (search) url += `&filter=${encodeURIComponent(search)}`;
      const raw = await get<Record<string, unknown>>(url);
      const entries = (raw.items ?? raw.entries ?? []) as BrowseItem[];
      const total = Number(raw.total ?? entries.length);

      if (append) {
        setItems(prev => [...prev, ...entries]);
      } else {
        setItems(entries);
      }
      setHasMore(fetchOffset + entries.length < total);
      setOffset(fetchOffset + entries.length);
      setCurrentPath(path);

      // Build breadcrumbs
      const parts = path.split('/').filter(Boolean);
      const crumbs = [{ name: 'Library', path: '/' }];
      let p = '';
      for (const part of parts) {
        p += '/' + part;
        crumbs.push({ name: part, path: p });
      }
      setBreadcrumbs(crumbs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse library. Is the music share configured?');
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    fetchItems('/');
  }, []);

  // Debounced server-side filter
  useEffect(() => {
    if (navigatingRef.current) return; // Skip re-fetch during navigation
    if (filter.length === 0) {
      fetchItems(currentPath, false, '');
      return;
    }
    if (filter.length < 2) return; // Don't search for single chars
    const timer = setTimeout(() => {
      fetchItems(currentPath, false, filter);
    }, 400);
    return () => clearTimeout(timer);
  }, [filter]);

  const navigatingRef = { current: false };
  const handleNavigate = (path: string) => {
    navigatingRef.current = true;
    setFilter('');
    setOffset(0);
    fetchItems(path);
    setTimeout(() => { navigatingRef.current = false; }, 500);
  };

  const handleLoadMore = () => {
    fetchItems(currentPath, true);
  };

  const toggleSelect = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectAll = () => {
    const dirs = filteredItems.filter(i => i.isDirectory);
    setSelected(new Set(dirs.map(i => i.path)));
  };

  const clearSelection = () => setSelected(new Set());

  const handleSyncSelected = async () => {
    if (selected.size === 0) return;
    setSyncing(true);
    try {
      const paths = Array.from(selected).map(p => p.replace(/^\//, ''));
      await post('/music/sync', { mode: 'selected', paths });
      // Refresh local music after sync completes
      setTimeout(() => onFetchLocalMusic(), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start sync');
    } finally {
      setSyncing(false);
    }
  };

  const lowerFilter = filter.toLowerCase();
  const filteredItems = lowerFilter
    ? items.filter(i => i.name.toLowerCase().includes(lowerFilter))
    : items;

  if (syncActive && syncJob) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <h3 style={{ marginBottom: 'var(--space-4)' }}>Syncing Music</h3>
        <SyncProgress
          job={syncJob}
          onCancel={onCancelSync}
        />
      </div>
    );
  }

  return (
    <div class="library-tab">
      {/* Breadcrumbs */}
      <div class="library-tab__breadcrumbs">
        {breadcrumbs.map((crumb, idx) => (
          <span key={crumb.path}>
            {idx > 0 && <span class="library-tab__breadcrumb-sep"> / </span>}
            <button
              class={`library-tab__breadcrumb ${idx === breadcrumbs.length - 1 ? 'library-tab__breadcrumb--active' : ''}`}
              onClick={() => idx < breadcrumbs.length - 1 && handleNavigate(crumb.path)}
              disabled={idx === breadcrumbs.length - 1}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      {/* Filter */}
      <div style={{ marginBottom: 'var(--space-3)' }}>
        <input
          type="text"
          class="text-input"
          placeholder="Filter..."
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          style={{ width: '100%' }}
        />
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: 'var(--space-3)',
          background: 'var(--color-error-glow)',
          border: '1px solid var(--color-error)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--color-error)',
          fontSize: 'var(--text-sm)',
          marginBottom: 'var(--space-4)',
        }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && items.length === 0 && (
        <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--color-text-muted)' }}>
          Loading library...
        </div>
      )}

      {/* Items */}
      {filteredItems.length > 0 && (
        <div class="library-tab__list">
          <div class="library-tab__list-header text-xs text-muted" style={{
            display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-2)',
          }}>
            <span>{filteredItems.length} items</span>
            <span>
              {selected.size > 0 && (
                <button class="btn btn--ghost btn--xs" onClick={clearSelection} style={{ marginRight: 'var(--space-2)' }}>
                  Clear
                </button>
              )}
              <button class="btn btn--ghost btn--xs" onClick={selectAll}>
                Select All Folders
              </button>
            </span>
          </div>
          {filteredItems.map((item) => (
            <div
              key={item.path}
              class={`library-tab__item ${selected.has(item.path) ? 'library-tab__item--selected' : ''}`}
            >
              {item.isDirectory && (
                <input
                  type="checkbox"
                  checked={selected.has(item.path)}
                  onChange={() => toggleSelect(item.path)}
                  style={{ marginRight: 'var(--space-3)', accentColor: 'var(--color-accent)' }}
                />
              )}
              <span class="library-tab__item-name">
                {item.isDirectory && (
                  <button
                    onClick={() => { setFilter(''); handleNavigate(item.path); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', marginRight: 'var(--space-1)' }}
                    title={`Browse ${item.name}`}
                  >
                    {'\uD83D\uDCC1'}
                  </button>
                )}
                {!item.isDirectory && (
                  <span style={{ marginRight: 'var(--space-2)', opacity: 0.5 }}>{'\uD83C\uDFB5'}</span>
                )}
                <span>{item.name}</span>
              </span>
              {item.size > 0 && (
                <span class="library-tab__item-size text-xs text-muted">
                  {formatBytes(item.size)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <div style={{ textAlign: 'center', padding: 'var(--space-4)' }}>
          <button class="btn btn--ghost" onClick={handleLoadMore} disabled={loading}>
            {loading ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}

      {/* Selection bar */}
      {selected.size > 0 && (
        <div class="library-tab__selection-bar">
          <span class="text-sm">
            {selected.size} item{selected.size !== 1 ? 's' : ''} selected
          </span>
          <button
            class="btn btn--primary btn--sm"
            onClick={handleSyncSelected}
            disabled={syncing}
          >
            {syncing ? 'Starting...' : 'Sync Selected'}
          </button>
        </div>
      )}
    </div>
  );
}
