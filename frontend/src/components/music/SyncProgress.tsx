import { useState } from 'preact/hooks';
import { ProgressBar } from '../common/ProgressBar';
import type { MusicSyncJob } from '../../api/types';

interface SyncProgressProps {
  job: MusicSyncJob;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function CheckIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

export function SyncProgress({ job, onCancel }: SyncProgressProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);

  const isActive = job.status === 'running' || job.status === 'pending';
  const isCompleted = job.status === 'completed';
  const isFailed = job.status === 'failed';
  const isCancelled = job.status === 'cancelled';

  const progress = job.bytes_total > 0
    ? job.bytes_copied / job.bytes_total
    : job.files_total > 0
      ? job.files_copied / job.files_total
      : 0;

  // Estimate speed and ETA
  const elapsed = job.started_at
    ? (Date.now() - new Date(job.started_at).getTime()) / 1000
    : 0;
  const speed = elapsed > 0 ? job.bytes_copied / elapsed : 0;
  const remaining = speed > 0 ? (job.bytes_total - job.bytes_copied) / speed : 0;

  function handleCancel() {
    if (confirmCancel) {
      onCancel();
      setConfirmCancel(false);
    } else {
      setConfirmCancel(true);
      setTimeout(() => setConfirmCancel(false), 5000);
    }
  }

  return (
    <div class="sync-progress">
      {/* Completion states */}
      {isCompleted && (
        <div class="sync-progress__done">
          <CheckIcon />
          <div style={{ marginLeft: 'var(--space-3)' }}>
            <div class="font-semibold" style={{ color: 'var(--color-success)' }}>Sync Complete</div>
            <div class="text-sm text-secondary">
              {job.files_copied.toLocaleString()} files ({formatBytes(job.bytes_copied)})
            </div>
          </div>
        </div>
      )}

      {isFailed && (
        <div class="sync-progress__done">
          <ErrorIcon />
          <div style={{ marginLeft: 'var(--space-3)' }}>
            <div class="font-semibold" style={{ color: 'var(--color-error)' }}>Sync Failed</div>
            <div class="text-sm text-secondary">
              {job.error_message || 'Unknown error'}
            </div>
          </div>
        </div>
      )}

      {isCancelled && (
        <div class="sync-progress__done">
          <div class="font-semibold text-secondary">Sync Cancelled</div>
          <div class="text-sm text-muted">
            {job.files_copied.toLocaleString()} of {job.files_total.toLocaleString()} files copied
          </div>
        </div>
      )}

      {/* Active sync */}
      {isActive && (
        <div class="sync-progress__active">
          <div class="sync-progress__header">
            <div class="flex items-center">
              <span class="sync-progress__pulse animate-pulse" />
              <span class="font-semibold" style={{ marginLeft: 'var(--space-2)' }}>
                {job.status === 'pending' ? 'Preparing...' : 'Syncing...'}
              </span>
            </div>
            <span class="text-sm font-mono" style={{ color: 'var(--color-accent)' }}>
              {Math.round(progress * 100)}%
            </span>
          </div>

          <ProgressBar
            value={progress}
            label={`${job.files_copied.toLocaleString()} / ${job.files_total.toLocaleString()} files`}
            size="sm"
            color="accent"
          />

          <div class="sync-progress__details">
            <div class="sync-progress__stat">
              <span class="text-muted text-xs">Copied</span>
              <span class="text-sm font-mono">{formatBytes(job.bytes_copied)}</span>
            </div>
            <div class="sync-progress__stat">
              <span class="text-muted text-xs">Total</span>
              <span class="text-sm font-mono">{formatBytes(job.bytes_total)}</span>
            </div>
            <div class="sync-progress__stat">
              <span class="text-muted text-xs">Speed</span>
              <span class="text-sm font-mono">{speed > 0 ? `${formatBytes(speed)}/s` : '--'}</span>
            </div>
            <div class="sync-progress__stat">
              <span class="text-muted text-xs">ETA</span>
              <span class="text-sm font-mono">{remaining > 0 ? formatDuration(remaining) : '--'}</span>
            </div>
          </div>

          <button
            class={`btn btn--sm ${confirmCancel ? 'btn--danger' : 'btn--ghost'}`}
            onClick={handleCancel}
            style={{ marginTop: 'var(--space-3)', width: '100%' }}
          >
            {confirmCancel ? 'Confirm Cancel' : 'Cancel Sync'}
          </button>
        </div>
      )}
    </div>
  );
}
