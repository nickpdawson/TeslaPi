import { useState, useEffect } from 'preact/hooks';
import { Card } from '../common/Card';
import { ProgressBar } from '../common/ProgressBar';
import { get } from '../../api/client';
import type { MusicSyncStatus, MusicSyncJob } from '../../api/types';

interface MusicCardProps {
  music: MusicSyncStatus;
}

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function MusicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

export function MusicCard({ music }: MusicCardProps) {
  const [syncJob, setSyncJob] = useState<MusicSyncJob | null>(null);

  // Poll sync status when syncing
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    async function poll() {
      try {
        const data = await get<{ status: string; job: MusicSyncJob | null }>('/music/sync/status');
        if (!cancelled) {
          setSyncJob(data.job);
          if (data.status === 'running' || data.status === 'pending') {
            timer = setTimeout(poll, 2000);
          }
        }
      } catch {
        // Ignore polling errors
      }
    }

    if (music.status === 'syncing') {
      poll();
    } else {
      // Fetch once to get latest status
      poll();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [music.status]);

  const isSyncing = music.status === 'syncing' || (syncJob?.status === 'running');
  const isIndexing = music.status === 'indexing';

  // Use live sync job data if available
  const progress = syncJob && (syncJob.status === 'running' || syncJob.status === 'pending')
    ? {
        filesCopied: syncJob.files_copied,
        filesTotal: syncJob.files_total,
        bytesCopied: syncJob.bytes_copied,
        bytesTotal: syncJob.bytes_total,
      }
    : music.progress;

  return (
    <Card title="Music" icon={<MusicIcon />}>
      {music.artistsSynced === 0 && music.status === 'idle' && !syncJob ? (
        <div class="empty-state">
          <MusicIcon />
          <p class="empty-state__text" style={{ marginTop: 'var(--space-3)' }}>No music share configured</p>
        </div>
      ) : (
        <div>
          {/* Stats */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: 'var(--space-4)',
          }}>
            <div>
              <div style={{
                fontSize: 'var(--text-2xl)',
                fontWeight: 'var(--font-weight-bold)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text)',
              }}>
                {music.artistsSynced.toLocaleString()}
              </div>
              <div style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}>
                Artists synced
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--color-text-secondary)',
              }}>
                {formatRelativeTime(music.lastSyncTime)}
              </div>
              <div style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text-muted)',
              }}>
                Last sync
              </div>
            </div>
          </div>

          {/* Progress bar when syncing */}
          {isSyncing && progress && (
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <ProgressBar
                value={progress.filesTotal > 0 ? progress.filesCopied / progress.filesTotal : 0}
                label={`Syncing ${progress.filesCopied.toLocaleString()} / ${progress.filesTotal.toLocaleString()} files`}
                size="sm"
                color="accent"
              />
              <div style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text-muted)',
                marginTop: 'var(--space-1)',
              }}>
                {formatBytes(progress.bytesCopied)} / {formatBytes(progress.bytesTotal)}
              </div>
            </div>
          )}

          {/* Status badge */}
          {(isSyncing || isIndexing) && (
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: 'var(--space-1) var(--space-3)',
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-accent-glow)',
              color: 'var(--color-accent)',
              fontSize: 'var(--text-xs)',
              fontWeight: 'var(--font-weight-medium)',
              marginBottom: 'var(--space-4)',
            }}>
              <span class="animate-pulse" style={{ marginRight: 'var(--space-2)' }}>
                {isSyncing ? 'Syncing...' : 'Indexing...'}
              </span>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <a href="/music" class="btn btn--ghost btn--sm" style={{ textDecoration: 'none', marginRight: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
              Browse & Sync
            </a>
          </div>
        </div>
      )}
    </Card>
  );
}
