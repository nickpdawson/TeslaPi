import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { MusicArtist, MusicAlbum, MusicSearchResult } from '../../api/types';
import type { SyncSelection } from './SyncQueue';

interface LibraryBrowserProps {
  artists: MusicArtist[];
  artistsTotal: number;
  albums: Record<string, MusicAlbum[]>;
  searchResults: MusicSearchResult[] | null;
  searchLoading: boolean;
  loading: boolean;
  indexed: boolean;
  selections: Map<string, SyncSelection>;
  onFetchArtists: (limit: number, offset: number) => void;
  onFetchAlbums: (artist: string) => void;
  onToggleSelection: (path: string, selection: SyncSelection) => void;
  onIndexLibrary: () => void;
}

const ITEM_HEIGHT = 52;
const BUFFER_ITEMS = 10;
const PAGE_SIZE = 50;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}
    >
      <polyline points="6,3 11,8 6,13" />
    </svg>
  );
}

function MusicNoteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

export function LibraryBrowser({
  artists,
  artistsTotal,
  albums,
  searchResults,
  searchLoading,
  loading,
  indexed,
  selections,
  onFetchArtists,
  onFetchAlbums,
  onToggleSelection,
  onIndexLibrary,
}: LibraryBrowserProps) {
  const [expandedArtists, setExpandedArtists] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // Virtual scrolling calculations
  const totalItems = artists.length;
  const totalHeight = totalItems * ITEM_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_ITEMS);
  const endIndex = Math.min(totalItems, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + BUFFER_ITEMS);
  const visibleArtists = artists.slice(startIndex, endIndex);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);

    function handleScroll() {
      setScrollTop(el!.scrollTop);

      // Load more when near bottom
      const remaining = totalHeight - (el!.scrollTop + el!.clientHeight);
      if (remaining < ITEM_HEIGHT * 5 && artists.length < artistsTotal && !loading) {
        onFetchArtists(PAGE_SIZE, artists.length);
      }
    }

    function handleResize() {
      setContainerHeight(el!.clientHeight);
    }

    el.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleResize);
    return () => {
      el.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
  }, [artists.length, artistsTotal, loading, totalHeight]);

  const toggleArtistExpand = useCallback((artist: string) => {
    setExpandedArtists((prev) => {
      const next = new Set(prev);
      if (next.has(artist)) {
        next.delete(artist);
      } else {
        next.add(artist);
        // Fetch albums if not already loaded
        if (!albums[artist]) {
          onFetchAlbums(artist);
        }
      }
      return next;
    });
  }, [albums, onFetchAlbums]);

  const toggleArtistSelect = useCallback((artist: MusicArtist) => {
    const path = `/${artist.artist}`;
    const sel: SyncSelection = {
      path,
      label: artist.artist,
      type: 'artist',
      trackCount: artist.track_count,
      totalSize: artist.total_size,
    };
    onToggleSelection(path, sel);
  }, [onToggleSelection]);

  const toggleAlbumSelect = useCallback((artist: string, album: MusicAlbum) => {
    const path = `/${artist}/${album.album}`;
    const sel: SyncSelection = {
      path,
      label: `${artist} - ${album.album}`,
      type: 'album',
      trackCount: album.track_count,
      totalSize: album.total_size,
    };
    onToggleSelection(path, sel);
  }, [onToggleSelection]);

  // Not indexed yet — empty state
  if (!indexed && !loading) {
    return (
      <div class="library-browser__empty">
        <DatabaseIcon />
        <h3 style={{ marginTop: 'var(--space-4)' }}>Library not indexed yet</h3>
        <p class="text-sm text-secondary" style={{ marginTop: 'var(--space-2)', maxWidth: '300px', textAlign: 'center' }}>
          Index your music share to browse and search your library.
        </p>
        <button class="btn btn--primary" onClick={onIndexLibrary} style={{ marginTop: 'var(--space-4)' }}>
          Index Now
        </button>
      </div>
    );
  }

  // Search results mode
  if (searchResults !== null) {
    return (
      <div class="library-browser" ref={containerRef}>
        {searchLoading && (
          <div class="library-browser__loading">
            <div class="skeleton" style={{ height: '40px', marginBottom: 'var(--space-2)' }} />
            <div class="skeleton" style={{ height: '40px', marginBottom: 'var(--space-2)' }} />
            <div class="skeleton" style={{ height: '40px' }} />
          </div>
        )}
        {!searchLoading && searchResults.length === 0 && (
          <div class="library-browser__empty">
            <MusicNoteIcon />
            <p class="text-sm text-secondary" style={{ marginTop: 'var(--space-2)' }}>
              No results found
            </p>
          </div>
        )}
        {!searchLoading && searchResults.map((result) => (
          <div key={`${result.artist}/${result.album}`} class="library-browser__search-group">
            <div class="library-browser__search-header">
              <span class="font-semibold">{result.artist}</span>
              <span class="text-muted"> &mdash; </span>
              <span class="text-secondary">{result.album}</span>
            </div>
            <div class="library-browser__search-tracks">
              {result.tracks.map((track) => (
                <div key={track.id} class="library-browser__track">
                  <span class="truncate">{track.filename}</span>
                  <span class="text-xs text-muted">{formatBytes(track.size_bytes)}</span>
                </div>
              ))}
            </div>
            <div class="library-browser__search-meta text-xs text-muted">
              {result.tracks.length} tracks &middot; {formatBytes(result.total_size)}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Loading skeleton
  if (loading && artists.length === 0) {
    return (
      <div class="library-browser">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} class="skeleton library-browser__skeleton-row" />
        ))}
      </div>
    );
  }

  // Normal artist/album browser with virtual scrolling
  return (
    <div class="library-browser" ref={containerRef}>
      <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
        <div style={{ position: 'absolute', top: `${startIndex * ITEM_HEIGHT}px`, left: 0, right: 0 }}>
          {visibleArtists.map((artist) => {
            const isExpanded = expandedArtists.has(artist.artist);
            const isSelected = selections.has(`/${artist.artist}`);
            const artistAlbums = albums[artist.artist] || [];

            return (
              <div key={artist.artist}>
                <div class={`library-browser__artist ${isSelected ? 'library-browser__artist--selected' : ''}`}>
                  <label class="library-browser__checkbox-wrap">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleArtistSelect(artist)}
                    />
                  </label>
                  <button
                    class="library-browser__artist-btn"
                    onClick={() => toggleArtistExpand(artist.artist)}
                  >
                    <ChevronIcon open={isExpanded} />
                    <span class="library-browser__artist-name truncate">{artist.artist}</span>
                  </button>
                  <span class="library-browser__artist-meta text-xs text-muted">
                    {artist.album_count} albums &middot; {artist.track_count} tracks &middot; {formatBytes(artist.total_size)}
                  </span>
                </div>

                {isExpanded && (
                  <div class="library-browser__albums">
                    {artistAlbums.length === 0 && (
                      <div class="library-browser__album-loading">
                        <div class="skeleton" style={{ height: '36px', marginBottom: 'var(--space-1)' }} />
                        <div class="skeleton" style={{ height: '36px' }} />
                      </div>
                    )}
                    {artistAlbums.map((album) => {
                      const albumPath = `/${artist.artist}/${album.album}`;
                      const albumSelected = selections.has(albumPath) || isSelected;

                      return (
                        <div
                          key={album.album}
                          class={`library-browser__album ${albumSelected ? 'library-browser__album--selected' : ''}`}
                        >
                          <label class="library-browser__checkbox-wrap">
                            <input
                              type="checkbox"
                              checked={albumSelected}
                              onChange={() => toggleAlbumSelect(artist.artist, album)}
                              disabled={isSelected}
                            />
                          </label>
                          <span class="library-browser__album-name truncate">{album.album}</span>
                          <span class="library-browser__album-meta text-xs text-muted">
                            {album.track_count} tracks &middot; {formatBytes(album.total_size)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {loading && artists.length > 0 && (
        <div class="library-browser__loading-more text-sm text-muted" style={{ padding: 'var(--space-3)', textAlign: 'center' }}>
          Loading more...
        </div>
      )}
    </div>
  );
}
