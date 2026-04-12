import { useState, useEffect, useCallback } from 'preact/hooks';
import { Card } from '../common/Card';
import { ProgressBar } from '../common/ProgressBar';
import { get, post, del } from '../../api/client';
import type { ArchiveStatus, ArchiveJob, ArchiveFullStatus } from '../../api/types';

interface ArchiveCardProps {
  archive: ArchiveStatus;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function ArchiveIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

/** Transform snake_case API response to camelCase ArchiveFullStatus.
 * The /api/archive/status returns a flat structure:
 * { latest_job: {...}|null, total_clips: N, total_bytes: N, server_name: "...", server_reachable: bool }
 */
function transformArchiveStatus(raw: Record<string, unknown>): ArchiveFullStatus {
  const jobRaw = (raw.latest_job ?? raw.job ?? null) as Record<string, unknown> | null;

  let job: ArchiveJob | null = null;
  if (jobRaw) {
    job = {
      id: Number(jobRaw.id ?? 0),
      status: String(jobRaw.status ?? 'pending') as ArchiveJob['status'],
      trigger: String(jobRaw.trigger ?? ''),
      clipsTotal: Number(jobRaw.clips_total ?? jobRaw.clipsTotal ?? 0),
      clipsCopied: Number(jobRaw.clips_copied ?? jobRaw.clipsCopied ?? 0),
      bytesTotal: Number(jobRaw.bytes_total ?? jobRaw.bytesTotal ?? 0),
      bytesCopied: Number(jobRaw.bytes_copied ?? jobRaw.bytesCopied ?? 0),
      clipsDeleted: Number(jobRaw.clips_deleted ?? jobRaw.clipsDeleted ?? 0),
      errorMessage: (jobRaw.error_message ?? jobRaw.errorMessage ?? null) as string | null,
      startedAt: (jobRaw.started_at ?? jobRaw.startedAt ?? null) as string | null,
      completedAt: (jobRaw.completed_at ?? jobRaw.completedAt ?? null) as string | null,
    };
  }

  return {
    status: job?.status === 'running' ? 'running' : (job?.status === 'failed' ? 'error' : 'idle'),
    job,
    stats: {
      totalClipsArchived: Number(raw.total_clips ?? 0),
      totalBytesArchived: Number(raw.total_bytes ?? 0),
      serverReachable: Boolean(raw.server_reachable ?? false),
      serverName: String(raw.server_name ?? ''),
    },
  };
}

export function ArchiveCard({ archive }: ArchiveCardProps) {
  const [fullStatus, setFullStatus] = useState<ArchiveFullStatus | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isRunning = fullStatus?.status === 'running' ||
    fullStatus?.job?.status === 'running' ||
    fullStatus?.job?.status === 'pending';

  const fetchArchiveStatus = useCallback(async () => {
    try {
      const raw = await get<Record<string, unknown>>('/archive/status');
      setFullStatus(transformArchiveStatus(raw));
    } catch {
      // Fall back to dashboard-level archive data; don't overwrite existing fullStatus
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    async function poll() {
      await fetchArchiveStatus();
      if (!cancelled) {
        const interval = isRunning ? 3000 : 10000;
        timer = setTimeout(poll, interval);
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchArchiveStatus, isRunning]);

  async function handleArchiveNow() {
    setActionPending(true);
    setActionError(null);
    try {
      await post('/archive/start', { trigger: 'manual' });
      // Immediately refresh status
      await fetchArchiveStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start archive');
    } finally {
      setActionPending(false);
    }
  }

  async function handleCancel() {
    setActionPending(true);
    setActionError(null);
    try {
      await del('/archive');
      await fetchArchiveStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel');
    } finally {
      setActionPending(false);
    }
  }

  // Merge data: prefer fullStatus from /api/archive/status, fall back to dashboard status
  const serverName = fullStatus?.stats.serverName || archive.serverName || '';
  const serverReachable = fullStatus?.stats.serverReachable ?? archive.serverReachable;
  // Consider configured if the dedicated endpoint returned a server name, OR if the
  // dashboard status has archive data. Don't show "not configured" while loading.
  const isConfigured = serverName.length > 0 || fullStatus !== null || archive.serverReachable;
  const job = fullStatus?.job ?? null;
  const currentStatus = fullStatus?.status ?? archive.status;

  const statusColor = serverReachable ? 'var(--color-success)' : 'var(--color-error)';

  // Determine card state
  const isError = currentStatus === 'error' || job?.status === 'failed';
  const isUnreachable = currentStatus === 'unreachable' || !serverReachable;
  const isIdle = !isRunning && !isError;

  return (
    <Card title="Archive" icon={<ArchiveIcon />}>
      {!isConfigured ? (
        <div class="empty-state">
          <ArchiveIcon />
          <p class="empty-state__text" style={{ marginTop: 'var(--space-3)' }}>No archive configured</p>
        </div>
      ) : (
        <div>
          {/* Server Status */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            marginBottom: 'var(--space-4)',
            padding: 'var(--space-3)',
            background: serverReachable ? 'var(--color-success-glow)' : 'var(--color-error-glow)',
            borderRadius: 'var(--radius-md)',
          }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: statusColor,
              display: 'inline-block',
              marginRight: 'var(--space-3)',
              boxShadow: `0 0 6px ${statusColor}`,
            }} />
            <span style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 'var(--font-weight-medium)',
              color: 'var(--color-text)',
            }}>
              {serverName}
            </span>
            <span style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-text-muted)',
              marginLeft: 'auto',
            }}>
              {serverReachable ? 'Reachable' : 'Unreachable'}
            </span>
          </div>

          {/* Unreachable Warning */}
          {isUnreachable && !isRunning && (
            <div style={{
              padding: 'var(--space-3)',
              background: 'var(--color-warning-glow)',
              border: '1px solid var(--color-warning)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-4)',
            }}>
              <span style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--color-warning)',
              }}>
                Archive server is offline. Archive will resume when reachable.
              </span>
            </div>
          )}

          {/* Running: Progress */}
          {isRunning && job && (
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <ProgressBar
                value={job.clipsTotal > 0 ? job.clipsCopied / job.clipsTotal : 0}
                label={`Archiving ${job.clipsCopied} / ${job.clipsTotal} clips`}
                size="sm"
                color="warning"
              />
              <div style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text-muted)',
                marginTop: 'var(--space-1)',
              }}>
                {formatBytes(job.bytesCopied)} / {formatBytes(job.bytesTotal)}
              </div>

              {/* Status badge */}
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: 'var(--space-1) var(--space-3)',
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-warning-glow)',
                color: 'var(--color-warning)',
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--font-weight-medium)',
                marginTop: 'var(--space-3)',
              }}>
                <span class="animate-pulse" style={{ marginRight: 'var(--space-2)' }}>
                  Archiving...
                </span>
              </div>
            </div>
          )}

          {/* Error State */}
          {isError && job?.errorMessage && (
            <div style={{
              padding: 'var(--space-3)',
              background: 'var(--color-error-glow)',
              border: '1px solid var(--color-error)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-4)',
            }}>
              <div style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--color-error)',
                fontWeight: 'var(--font-weight-medium)',
                marginBottom: 'var(--space-1)',
              }}>
                Archive failed
              </div>
              <div style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text-muted)',
              }}>
                {job.errorMessage}
              </div>
            </div>
          )}

          {/* Completed / Last archive info (idle state) */}
          {isIdle && !isError && (
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 'var(--space-3)',
            }}>
              <div>
                <div style={{
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 'var(--font-weight-bold)',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text)',
                }}>
                  {(fullStatus?.stats.totalClipsArchived ?? archive.lastArchiveClips).toLocaleString()}
                </div>
                <div style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}>
                  Clips archived
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-text-secondary)',
                }}>
                  {formatRelativeTime(job?.completedAt ?? archive.lastArchiveTime)}
                </div>
                <div style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--color-text-muted)',
                }}>
                  Last archive
                </div>
              </div>
            </div>
          )}

          {/* Action error */}
          {actionError && (
            <div style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-error)',
              marginBottom: 'var(--space-3)',
            }}>
              {actionError}
            </div>
          )}

          {/* Action buttons */}
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            borderTop: '1px solid var(--color-border)',
            paddingTop: 'var(--space-3)',
          }}>
            {isRunning ? (
              <button
                class="btn btn--ghost btn--sm"
                onClick={handleCancel}
                disabled={actionPending}
                style={{
                  color: 'var(--color-error)',
                  marginRight: 'var(--space-2)',
                }}
              >
                {actionPending ? 'Cancelling...' : 'Cancel'}
              </button>
            ) : (
              <button
                class="btn btn--primary btn--sm"
                onClick={handleArchiveNow}
                disabled={actionPending || isUnreachable}
                style={{
                  marginRight: 'var(--space-2)',
                  opacity: (actionPending || isUnreachable) ? 0.5 : 1,
                }}
              >
                {actionPending ? 'Starting...' : isError ? 'Retry Archive' : 'Archive Now'}
              </button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
