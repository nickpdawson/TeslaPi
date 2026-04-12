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

function getRingColor(status: TeslaPiStatus): string {
  if (status.archive.status === 'archiving') return 'var(--color-accent)';
  if (status.archive.status === 'error' || status.archive.status === 'unreachable') return 'var(--color-warning)';
  return 'var(--color-success)';
}

function getRingLabel(status: TeslaPiStatus): string {
  if (status.archive.status === 'archiving') return 'Archiving';
  if (status.archive.status === 'error') return 'Error';
  if (status.archive.status === 'unreachable') return 'Unreachable';
  return 'All Systems Go';
}

export function StatusHero({ status }: StatusHeroProps) {
  const ringColor = getRingColor(status);
  const ringLabel = getRingLabel(status);
  const isAnimating = status.archive.status === 'archiving';

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
