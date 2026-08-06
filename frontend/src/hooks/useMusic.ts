import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { get, post, del } from '../api/client';
import { addNotification } from '../stores/appState';
import type {
  MusicArtist,
  MusicAlbum,
  MusicSearchResult,
  MusicLibraryStats,
  MusicSyncJob,
  MusicIndexingStatus,
  MusicBrowseResponse,
  MusicRandomItem,
  MusicRecentItem,
  LocalMusicData,
} from '../api/types';
import type { SyncSelection } from '../components/music/SyncQueue';

const DEBOUNCE_MS = 300;
const SYNC_POLL_MS = 2000;

export function useMusic() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<MusicLibraryStats | null>(null);
  const [artists, setArtists] = useState<MusicArtist[]>([]);
  const [artistsTotal, setArtistsTotal] = useState(0);
  const [albums, setAlbums] = useState<Record<string, MusicAlbum[]>>({});
  const [searchResults, setSearchResults] = useState<MusicSearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ status: string; job: MusicSyncJob | null }>({
    status: 'idle',
    job: null,
  });
  const [indexingStatus, setIndexingStatus] = useState<MusicIndexingStatus | null>(null);

  // Local music state
  const [localMusic, setLocalMusic] = useState<LocalMusicData | null>(null);
  const [localMusicLoading, setLocalMusicLoading] = useState(false);

  // Sync queue state
  const [syncQueue, setSyncQueue] = useState<Map<string, SyncSelection>>(new Map());

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Library ---

  const fetchStats = useCallback(async () => {
    try {
      const data = await get<MusicLibraryStats>('/music/library/stats');
      setStats(data);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch stats');
      return null;
    }
  }, []);

  const fetchArtists = useCallback(async (limit = 50, offset = 0, search = '') => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (search) params.set('search', search);
      const data = await get<{ artists: MusicArtist[]; total: number }>(
        `/music/library/artists?${params.toString()}`
      );
      setArtists(data.artists);
      setArtistsTotal(data.total);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch artists');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAlbums = useCallback(async (artist: string) => {
    try {
      const data = await get<{ artist: string; albums: MusicAlbum[] }>(
        `/music/library/artists/${encodeURIComponent(artist)}/albums`
      );
      setAlbums((prev) => ({ ...prev, [artist]: data.albums }));
      return data.albums;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch albums');
      return null;
    }
  }, []);

  const searchLibrary = useCallback((query: string) => {
    // Clear previous debounce
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await get<{ results: MusicSearchResult[]; count: number }>(
          `/music/library/search?q=${encodeURIComponent(query)}`
        );
        setSearchResults(data.results);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, DEBOUNCE_MS);
  }, []);

  const clearSearch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchResults(null);
    setSearchLoading(false);
  }, []);

  // --- Browse ---

  const browseLibrary = useCallback(async (path: string = '/', offset = 0, limit = 200) => {
    try {
      const params = new URLSearchParams({
        path,
        offset: String(offset),
        limit: String(limit),
      });
      const data = await get<MusicBrowseResponse>(
        `/music/library/browse?${params.toString()}`
      );
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse library');
      return null;
    }
  }, []);

  // --- Random ---

  const getRandomItems = useCallback(async (count: number = 20, type: string = 'artist') => {
    try {
      const params = new URLSearchParams({ count: String(count), type });
      const data = await get<{ items: MusicRandomItem[]; count: number; type: string }>(
        `/music/library/random?${params.toString()}`
      );
      return data.items;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get random items');
      return null;
    }
  }, []);

  // --- Recent ---

  const getRecentItems = useCallback(async (count: number = 50) => {
    try {
      const params = new URLSearchParams({ count: String(count) });
      const data = await get<{ items: MusicRecentItem[]; count: number }>(
        `/music/library/recent?${params.toString()}`
      );
      return data.items;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get recent items');
      return null;
    }
  }, []);

  // --- Local music ---

  const fetchLocalMusic = useCallback(async () => {
    setLocalMusicLoading(true);
    try {
      const data = await get<LocalMusicData>('/music/local');
      setLocalMusic(data);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch local music');
      return null;
    } finally {
      setLocalMusicLoading(false);
    }
  }, []);

  const deleteLocalMusic = useCallback(async (path: string) => {
    try {
      await post('/music/local/delete', { path });
      // Refresh local music data after deletion
      await fetchLocalMusic();
      return true;
    } catch (err) {
      // Surface action failures as a toast — otherwise the error was only stored in
      // state that nothing rendered, so users re-tapped a silently-failing button.
      const msg = err instanceof Error ? err.message : 'Failed to delete';
      setError(msg);
      addNotification('error', msg);
      return false;
    }
  }, [fetchLocalMusic]);

  const startFullSync = useCallback(async () => {
    try {
      const data = await post<{ job_id: number; status: string }>('/music/sync/full');
      startSyncPolling();
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start full sync';
      setError(msg);
      addNotification('error', msg);
      return null;
    }
  }, []);

  const startNewSync = useCallback(async () => {
    try {
      const data = await post<{ job_id: number | null; status: string; note?: string }>('/music/sync/new');
      if (data.job_id) {
        startSyncPolling();
      }
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start new sync';
      setError(msg);
      addNotification('error', msg);
      return null;
    }
  }, []);

  // --- Queue management ---

  const addToQueue = useCallback((items: SyncSelection[]) => {
    setSyncQueue((prev) => {
      const next = new Map(prev);
      for (const item of items) {
        next.set(item.path, item);
      }
      return next;
    });
  }, []);

  const removeFromQueue = useCallback((path: string) => {
    setSyncQueue((prev) => {
      const next = new Map(prev);
      next.delete(path);
      // Also remove child selections
      for (const key of Array.from(next.keys())) {
        if (key.startsWith(path + '/')) {
          next.delete(key);
        }
      }
      return next;
    });
  }, []);

  const clearQueue = useCallback(() => {
    setSyncQueue(new Map());
  }, []);

  const toggleQueueItem = useCallback((path: string, selection: SyncSelection) => {
    setSyncQueue((prev) => {
      const next = new Map(prev);
      if (next.has(path)) {
        next.delete(path);
        // If deselecting an artist, also remove its album selections
        if (selection.type === 'artist') {
          for (const key of Array.from(next.keys())) {
            if (key.startsWith(path + '/')) {
              next.delete(key);
            }
          }
        }
      } else {
        next.set(path, selection);
      }
      return next;
    });
  }, []);

  // --- Indexing ---

  const indexLibrary = useCallback(async () => {
    try {
      await post('/music/library/index');
      // Start polling indexing status
      pollIndexingStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start indexing';
      setError(msg);
      addNotification('error', msg);
    }
  }, []);

  const pollIndexingStatus = useCallback(async () => {
    try {
      const data = await get<MusicIndexingStatus>('/music/library/index/status');
      setIndexingStatus(data);
      if (data.active) {
        setTimeout(pollIndexingStatus, 1000);
      } else {
        // Indexing done — refresh stats
        fetchStats();
      }
    } catch {
      // Ignore polling errors
    }
  }, [fetchStats]);

  // --- Sync ---

  const startSync = useCallback(async (
    mode: string = 'selected',
    paths: string[] = [],
    count: number = 20,
    type: string = 'artist',
  ) => {
    try {
      const data = await post<{ job_id: number; status: string }>('/music/sync', {
        mode,
        paths,
        count,
        type,
      });
      startSyncPolling();
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start sync');
      return null;
    }
  }, []);

  const startSyncFromQueue = useCallback(async () => {
    const paths = Array.from(syncQueue.keys());
    if (paths.length === 0) return null;
    return startSync('selected', paths);
  }, [syncQueue, startSync]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const data = await get<{ status: string; job: MusicSyncJob | null }>('/music/sync/status');
      setSyncStatus(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  const startSyncPolling = useCallback(() => {
    if (syncPollRef.current) clearTimeout(syncPollRef.current);

    // Only announce the outcome if we actually observed the sync running in this
    // polling session — avoids toasting an old terminal job on a fresh page load.
    let sawActive = false;

    async function poll() {
      const data = await fetchSyncStatus();
      if (data && (data.status === 'pending' || data.status === 'running')) {
        sawActive = true;
        syncPollRef.current = setTimeout(poll, SYNC_POLL_MS);
      } else if (data && sawActive) {
        // Sync just reached a terminal state — surface it (the inline
        // SyncProgress card is unmounted once the job leaves the active state).
        const msg = data.job?.error_message;
        if (data.status === 'completed') {
          addNotification('success', 'Music sync complete.');
        } else if (data.status === 'partial') {
          addNotification('warning', msg || 'Music sync finished with some files skipped; they will retry on the next sync.');
        } else if (data.status === 'failed') {
          addNotification('error', msg || 'Music sync failed.');
        }
      }
    }
    poll();
  }, [fetchSyncStatus]);

  const cancelSync = useCallback(async () => {
    try {
      await del('/music/sync');
      await fetchSyncStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel sync');
    }
  }, [fetchSyncStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (syncPollRef.current) clearTimeout(syncPollRef.current);
    };
  }, []);

  return {
    // State
    loading,
    error,
    stats,
    artists,
    artistsTotal,
    albums,
    searchResults,
    searchLoading,
    syncStatus,
    indexingStatus,
    syncQueue,
    localMusic,
    localMusicLoading,

    // Actions
    fetchStats,
    fetchArtists,
    fetchAlbums,
    searchLibrary,
    clearSearch,
    browseLibrary,
    getRandomItems,
    getRecentItems,
    addToQueue,
    removeFromQueue,
    clearQueue,
    toggleQueueItem,
    indexLibrary,
    pollIndexingStatus,
    startSync,
    startSyncFromQueue,
    startFullSync,
    startNewSync,
    fetchSyncStatus,
    startSyncPolling,
    cancelSync,
    fetchLocalMusic,
    deleteLocalMusic,
  };
}
