import { useState, useEffect, useCallback } from 'preact/hooks';
import { useMusic } from '../../hooks/useMusic';
import { OnTeslaTab } from './OnTeslaTab';
import { LibraryTab } from './LibraryTab';
import type { MusicPageTab } from '../../api/types';

function IndexingBanner({ status }: { status: { active: boolean; total_files: number; indexed_files: number } }) {
  if (!status.active) return null;
  const progress = status.total_files > 0
    ? Math.round((status.indexed_files / status.total_files) * 100)
    : 0;

  return (
    <div class="music-page__indexing-banner">
      <span class="animate-pulse" style={{ marginRight: 'var(--space-2)', color: 'var(--color-accent)' }}>
        Indexing library...
      </span>
      <span class="font-mono text-sm">
        {status.indexed_files.toLocaleString()} / {status.total_files.toLocaleString()} files ({progress}%)
      </span>
    </div>
  );
}

function CarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 17h14v-5l-2-6H7l-2 6v5z" />
      <circle cx="7.5" cy="17.5" r="1.5" />
      <circle cx="16.5" cy="17.5" r="1.5" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

export function MusicPage({ path: _path }: { path?: string }) {
  const music = useMusic();
  const [activeTab, setActiveTab] = useState<MusicPageTab>('on-tesla');

  // Initial data load
  useEffect(() => {
    music.fetchStats();
    music.fetchSyncStatus();
  }, []);

  const handleIndexLibrary = useCallback(async () => {
    await music.indexLibrary();
  }, [music.indexLibrary]);

  const handleCancelSync = useCallback(async () => {
    await music.cancelSync();
  }, [music.cancelSync]);

  const syncJob = music.syncStatus?.job ?? null;
  const syncActive = syncJob?.status === 'running' || syncJob?.status === 'pending';

  return (
    <div class="music-page">
      {/* Header */}
      <div class="music-page__header">
        <div class="music-page__title-row">
          <h1 class="text-2xl font-bold">Music</h1>
          <div class="music-page__header-actions">
            {(music.stats?.total_tracks ?? 0) > 0 && (
              <button
                class="btn btn--ghost btn--sm"
                onClick={handleIndexLibrary}
                disabled={music.indexingStatus?.active}
              >
                {music.indexingStatus?.active ? 'Indexing...' : 'Re-index'}
              </button>
            )}
          </div>
        </div>

        {/* Indexing progress */}
        {music.indexingStatus && <IndexingBanner status={music.indexingStatus} />}

        {/* Tab selector */}
        <div class="music-page__tab-selector">
          <button
            class={`music-page__tab-btn ${activeTab === 'on-tesla' ? 'music-page__tab-btn--active' : ''}`}
            onClick={() => setActiveTab('on-tesla')}
          >
            <CarIcon />
            <span>On Tesla</span>
          </button>
          <button
            class={`music-page__tab-btn ${activeTab === 'library' ? 'music-page__tab-btn--active' : ''}`}
            onClick={() => setActiveTab('library')}
          >
            <LibraryIcon />
            <span>Library</span>
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div class="music-page__content">
        {activeTab === 'on-tesla' && (
          <OnTeslaTab
            localMusic={music.localMusic}
            localMusicLoading={music.localMusicLoading}
            syncJob={syncJob}
            syncActive={syncActive}
            onFetchLocalMusic={music.fetchLocalMusic}
            onDeleteLocalMusic={music.deleteLocalMusic}
            onStartFullSync={music.startFullSync}
            onStartNewSync={music.startNewSync}
            onCancelSync={handleCancelSync}
          />
        )}
        {activeTab === 'library' && (
          <LibraryTab
            syncJob={syncJob}
            syncActive={syncActive}
            onCancelSync={handleCancelSync}
            onFetchLocalMusic={music.fetchLocalMusic}
          />
        )}
      </div>
    </div>
  );
}
