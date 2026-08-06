import type { TeslaPiStatus } from '../../api/types';

interface StatusHeroProps {
  status: TeslaPiStatus;
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
  return `${days}d ago`;
}

// Reflect the backend's overall `state` (which weighs archiving/syncing/failure/
// connected across sub-systems) rather than re-deriving health from archive.status
// alone — which showed "All Systems Go" during a music sync or a failed archive job.
function getRingColor(status: TeslaPiStatus): string {
  if (status.state === 'error') return 'var(--color-error)';
  if (status.state === 'offline' || status.archive.status === 'unreachable') return 'var(--color-warning)';
  if (status.state === 'archiving' || status.state === 'syncing') return 'var(--color-accent)';
  return 'var(--color-success)';  // connected / idle
}

export function getRingLabel(status: TeslaPiStatus): string {
  switch (status.state) {
    case 'archiving': return 'Archiving';
    case 'syncing': return 'Syncing';
    case 'error': return 'Error';
    case 'offline': return 'Offline';
  }
  // No top-level problem — surface an unreachable archive server if that's the case.
  if (status.archive.status === 'unreachable') return 'Server Unreachable';
  if (status.state === 'connected') return 'Connected';
  return 'All Systems Go';  // idle
}

export function StatusHero({ status }: StatusHeroProps) {
  const ringColor = getRingColor(status);
  const ringLabel = getRingLabel(status);
  const isAnimating = status.state === 'archiving' || status.state === 'syncing';

  return (
    <div class="card card--full" style={{ overflow: 'visible' }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: 'var(--space-4) 0',
      }}>
        {/* Status Ring */}
        <div style={{
          position: 'relative',
          width: '100px',
          height: '100px',
          marginBottom: 'var(--space-6)',
        }}>
          {/* Outer ring */}
          <div style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: `3px solid ${ringColor}`,
            opacity: 0.2,
          }} />
          {/* Animated arc */}
          <div style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '3px solid transparent',
            borderTopColor: ringColor,
            borderRightColor: ringColor,
            animation: isAnimating ? 'ring-rotate 2s linear infinite' : 'none',
            transform: isAnimating ? undefined : 'rotate(0deg)',
          }} />
          {/* Pulse glow */}
          <div style={{
            position: 'absolute',
            inset: '-4px',
            borderRadius: '50%',
            '--ring-color': ringColor,
            animation: 'ring-pulse 2s ease-in-out infinite',
          } as any} />
          {/* Center content */}
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <span style={{
              fontSize: 'var(--text-xs)',
              color: ringColor,
              fontWeight: 'var(--font-weight-semibold)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              {ringLabel}
            </span>
          </div>
        </div>

        {/* Stats Row */}
        <div style={{
          display: 'flex',
          width: '100%',
          justifyContent: 'center',
          flexWrap: 'wrap',
        }}>
          <StatItem
            label="CPU Temp"
            value={`${(status.system.cpuTemp ?? 0).toFixed(1)}\u00B0C`}
            color={(status.system.cpuTemp ?? 0) > 70 ? 'var(--color-error)' : (status.system.cpuTemp ?? 0) > 55 ? 'var(--color-warning)' : 'var(--color-text)'}
          />
          <StatItem
            label="Uptime"
            value={status.system.uptime}
            color="var(--color-text)"
          />
          <StatItem
            label="Last Archive"
            value={formatRelativeTime(status.archive.lastArchiveTime)}
            color="var(--color-text)"
          />
        </div>
      </div>
    </div>
  );
}

function StatItem({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      textAlign: 'center',
      padding: 'var(--space-2) var(--space-6)',
      minWidth: '120px',
    }}>
      <div style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--color-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        marginBottom: 'var(--space-1)',
        fontWeight: 'var(--font-weight-medium)',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 'var(--text-xl)',
        fontWeight: 'var(--font-weight-semibold)',
        color,
        fontFamily: 'var(--font-mono)',
      }}>
        {value}
      </div>
    </div>
  );
}
