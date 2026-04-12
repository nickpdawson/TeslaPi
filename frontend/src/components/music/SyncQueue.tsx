import { SyncProgress } from './SyncProgress';
import type { MusicSyncJob } from '../../api/types';

interface SyncSelection {
  path: string;
  label: string;
  type: 'artist' | 'album';
  trackCount: number;
  totalSize: number;
}

interface SyncQueueProps {
  selections: SyncSelection[];
  syncJob: MusicSyncJob | null;
  syncActive: boolean;
  onRemove: (path: string) => void;
  onClearAll: () => void;
  onStartSync: () => void;
  onCancelSync: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export function SyncQueue({
  selections,
  syncJob,
  syncActive: _syncActive,
  onRemove,
  onClearAll,
  onStartSync,
  onCancelSync,
}: SyncQueueProps) {
  void _syncActive;
  // Show sync progress if there is an active/recent job
  if (syncJob && (syncJob.status === 'running' || syncJob.status === 'pending')) {
    return (
      <div class="sync-queue">
        <div class="sync-queue__header">
          <h3 class="text-lg font-semibold">Sync Status</h3>
        </div>
        <SyncProgress job={syncJob} onCancel={onCancelSync} />
      </div>
    );
  }

  // Show recent completion
  if (syncJob && (syncJob.status === 'completed' || syncJob.status === 'failed' || syncJob.status === 'cancelled')) {
    const isRecent = syncJob.completed_at
      ? Date.now() - new Date(syncJob.completed_at).getTime() < 300000 // 5 min
      : false;

    if (isRecent) {
      return (
        <div class="sync-queue">
          <div class="sync-queue__header">
            <h3 class="text-lg font-semibold">Sync Status</h3>
          </div>
          <SyncProgress job={syncJob} onCancel={onCancelSync} />
          {selections.length > 0 && (
            <div style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-4)' }}>
              <QueueList
                selections={selections}
                onRemove={onRemove}
                onClearAll={onClearAll}
                onStartSync={onStartSync}
              />
            </div>
          )}
        </div>
      );
    }
  }

  // Empty state
  if (selections.length === 0) {
    return (
      <div class="sync-queue">
        <div class="sync-queue__header">
          <h3 class="text-lg font-semibold">Sync Queue</h3>
        </div>
        <div class="sync-queue__empty">
          <SyncIcon />
          <p class="text-sm text-secondary" style={{ marginTop: 'var(--space-2)' }}>
            Select artists or albums from any mode to add them here
          </p>
        </div>
      </div>
    );
  }

  return (
    <div class="sync-queue">
      <div class="sync-queue__header">
        <h3 class="text-lg font-semibold">Sync Queue</h3>
        <span class="text-sm text-muted">{selections.length} item{selections.length !== 1 ? 's' : ''}</span>
      </div>
      <QueueList
        selections={selections}
        onRemove={onRemove}
        onClearAll={onClearAll}
        onStartSync={onStartSync}
      />
    </div>
  );
}

function QueueList({
  selections,
  onRemove,
  onClearAll,
  onStartSync,
}: {
  selections: SyncSelection[];
  onRemove: (path: string) => void;
  onClearAll: () => void;
  onStartSync: () => void;
}) {
  const totalSize = selections.reduce((sum, s) => sum + s.totalSize, 0);
  const totalTracks = selections.reduce((sum, s) => sum + s.trackCount, 0);

  return (
    <>
      <div class="sync-queue__list">
        {selections.map((sel) => (
          <div key={sel.path} class="sync-queue__item">
            <div class="sync-queue__item-info">
              <div class="sync-queue__item-label truncate">
                {sel.label}
              </div>
              <div class="text-xs text-muted">
                {sel.trackCount > 0 ? `${sel.trackCount} tracks` : sel.type}
                {sel.totalSize > 0 && ` · ${formatBytes(sel.totalSize)}`}
              </div>
            </div>
            <button
              class="sync-queue__item-remove"
              onClick={() => onRemove(sel.path)}
              aria-label={`Remove ${sel.label}`}
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </div>

      <div class="sync-queue__summary">
        <div class="text-sm text-secondary">
          {selections.length} item{selections.length !== 1 ? 's' : ''}
          {totalTracks > 0 && ` · ${totalTracks.toLocaleString()} tracks`}
          {totalSize > 0 && ` · ${formatBytes(totalSize)}`}
        </div>
      </div>

      <div class="sync-queue__actions">
        <button class="btn btn--ghost btn--sm" onClick={onClearAll}>
          Clear All
        </button>
        <button class="btn btn--primary btn--sm" onClick={onStartSync}>
          <SyncIcon />
          <span style={{ marginLeft: 'var(--space-2)' }}>Sync Selected</span>
        </button>
      </div>
    </>
  );
}

export type { SyncSelection };
