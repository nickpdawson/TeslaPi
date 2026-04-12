import { useState, useEffect } from 'preact/hooks';
import { ProgressBar } from '../common/ProgressBar';
import { Modal } from '../common/Modal';
import { SyncProgress } from './SyncProgress';
import type { LocalMusicData, LocalMusicArtist, LocalMusicAlbum, MusicSyncJob } from '../../api/types';

interface OnTeslaTabProps {
  localMusic: LocalMusicData | null;
  localMusicLoading: boolean;
  syncJob: MusicSyncJob | null;
  syncActive: boolean;
  onFetchLocalMusic: () => Promise<unknown>;
  onDeleteLocalMusic: (path: string) => Promise<boolean>;
  onStartFullSync: () => Promise<unknown>;
  onStartNewSync: () => Promise<unknown>;
  onCancelSync: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{ transition: 'transform 0.2s ease', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function SyncIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function MusicNoteIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style={{ opacity: 0.3 }}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

function ArtistRow({
  artist,
  onDelete,
}: {
  artist: LocalMusicArtist;
  onDelete: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class="on-tesla__artist-group">
      <div class="on-tesla__artist-row">
        <button
          class="on-tesla__artist-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronIcon expanded={expanded} />
        </button>
        <button
          class="on-tesla__artist-name-btn"
          onClick={() => setExpanded(!expanded)}
        >
          <span class="on-tesla__artist-name truncate">{artist.name}</span>
          <span class="on-tesla__artist-meta text-xs text-muted">
            {artist.total_tracks} track{artist.total_tracks !== 1 ? 's' : ''} &middot; {formatBytes(artist.total_size)}
          </span>
        </button>
        <button
          class="on-tesla__delete-btn"
          onClick={() => onDelete(artist.name)}
          aria-label={`Delete ${artist.name}`}
        >
          <TrashIcon />
        </button>
      </div>
      {expanded && artist.albums.length > 0 && (
        <div class="on-tesla__albums">
          {artist.albums.map((album: LocalMusicAlbum) => (
            <AlbumRow key={album.name} album={album} />
          ))}
        </div>
      )}
    </div>
  );
}

function AlbumRow({ album }: { album: LocalMusicAlbum }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class="on-tesla__album-group">
      <button
        class="on-tesla__album-row"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronIcon expanded={expanded} />
        <span class="on-tesla__album-name truncate">{album.name}</span>
        <span class="on-tesla__album-meta text-xs text-muted">
          {album.track_count} track{album.track_count !== 1 ? 's' : ''} &middot; {formatBytes(album.total_size)}
        </span>
      </button>
      {expanded && album.tracks.length > 0 && (
        <div class="on-tesla__tracks">
          {album.tracks.map((track) => (
            <div key={track.name} class="on-tesla__track">
              <span class="on-tesla__track-name truncate text-sm text-secondary">{track.name}</span>
              <span class="on-tesla__track-size text-xs text-muted font-mono">{formatBytes(track.size)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Assume 1.7 TB music image capacity (default TeslaUSB music partition)
const MUSIC_IMAGE_CAPACITY = 1.7 * 1024 * 1024 * 1024 * 1024;

export function OnTeslaTab({
  localMusic,
  localMusicLoading,
  syncJob,
  syncActive,
  onFetchLocalMusic,
  onDeleteLocalMusic,
  onStartFullSync,
  onStartNewSync,
  onCancelSync,
}: OnTeslaTabProps) {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');

  useEffect(() => {
    onFetchLocalMusic();
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await onDeleteLocalMusic(`Music/${deleteTarget}`);
    setDeleting(false);
    setDeleteTarget(null);
  };

  const usedBytes = localMusic?.total_size ?? 0;
  const usedRatio = MUSIC_IMAGE_CAPACITY > 0 ? usedBytes / MUSIC_IMAGE_CAPACITY : 0;

  return (
    <div class="on-tesla">
      {/* Storage bar */}
      <div class="on-tesla__storage">
        <div class="on-tesla__storage-label">
          <span class="text-sm">
            <strong class="font-mono">{formatBytes(usedBytes)}</strong>
            <span class="text-muted"> used of </span>
            <strong class="font-mono">{formatBytes(MUSIC_IMAGE_CAPACITY)}</strong>
          </span>
        </div>
        <ProgressBar value={usedRatio} size="sm" color="auto" />
      </div>

      {/* Quick actions */}
      <div class="on-tesla__actions">
        <button
          class="btn btn--primary btn--sm"
          onClick={onStartFullSync}
          disabled={syncActive}
        >
          <SyncIcon />
          <span style={{ marginLeft: 'var(--space-1)' }}>Sync Everything</span>
        </button>
        <button
          class="btn btn--ghost btn--sm"
          onClick={onStartNewSync}
          disabled={syncActive}
        >
          Sync New
        </button>
      </div>

      {/* Sync progress inline */}
      {syncJob && (syncJob.status === 'running' || syncJob.status === 'pending') && (
        <div class="on-tesla__sync-status">
          <SyncProgress job={syncJob} onCancel={onCancelSync} />
        </div>
      )}

      {/* Artist list */}
      <div class="on-tesla__artist-list">
        {localMusicLoading && !localMusic && (
          <div class="on-tesla__loading">
            <span class="text-sm text-muted animate-pulse">Scanning local music drive...</span>
          </div>
        )}

        {!localMusicLoading && localMusic && localMusic.artists.length === 0 && (
          <div class="on-tesla__empty">
            <MusicNoteIcon />
            <p class="text-sm text-muted" style={{ marginTop: 'var(--space-3)' }}>
              No music on your Tesla yet.
            </p>
            <p class="text-xs text-muted" style={{ marginTop: 'var(--space-1)' }}>
              Go to the Library tab to browse and sync music.
            </p>
          </div>
        )}

        {localMusic && localMusic.artists.length > 0 && (() => {
          const lowerFilter = searchFilter.toLowerCase();
          const filtered = lowerFilter
            ? localMusic.artists.filter(a => a.name.toLowerCase().includes(lowerFilter))
            : localMusic.artists;

          return (
          <>
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <input
                type="text"
                class="text-input"
                placeholder="Filter artists..."
                value={searchFilter}
                onInput={(e) => setSearchFilter((e.target as HTMLInputElement).value)}
                style={{ width: '100%' }}
              />
            </div>
            <div class="on-tesla__list-header text-xs text-muted">
              {filtered.length} of {localMusic.artists.length} artist{localMusic.artists.length !== 1 ? 's' : ''} &middot;{' '}
              {localMusic.total_tracks.toLocaleString()} tracks
            </div>
            {filtered.map((artist) => (
              <ArtistRow
                key={artist.name}
                artist={artist}
                onDelete={(name) => setDeleteTarget(name)}
              />
            ))}
          </>
          );
        })()}
      </div>

      {/* Sync status footer */}
      {!syncActive && (
        <div class="on-tesla__footer text-xs text-muted">
          Sync Status: Idle
        </div>
      )}

      {/* Delete confirmation modal */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Artist"
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        danger
      >
        <p class="text-sm">
          Remove <strong>{deleteTarget}</strong> and all their music from your Tesla?
        </p>
        <p class="text-sm text-muted" style={{ marginTop: 'var(--space-2)' }}>
          This will temporarily disconnect USB drives while the music image is modified.
          You can re-sync this artist later from the Library tab.
        </p>
      </Modal>
    </div>
  );
}
