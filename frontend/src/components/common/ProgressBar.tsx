interface ProgressBarProps {
  value: number; // 0 to 1
  label?: string;
  size?: 'sm' | 'md';
  color?: 'auto' | 'accent' | 'success' | 'warning' | 'error';
}

function getAutoColor(value: number): string {
  if (value >= 0.8) return 'var(--color-error)';
  if (value >= 0.6) return 'var(--color-warning)';
  return 'var(--color-success)';
}

function getNamedColor(color: string): string {
  switch (color) {
    case 'accent': return 'var(--color-accent)';
    case 'success': return 'var(--color-success)';
    case 'warning': return 'var(--color-warning)';
    case 'error': return 'var(--color-error)';
    default: return 'var(--color-accent)';
  }
}

export function ProgressBar({
  value,
  label,
  size = 'md',
  color = 'auto',
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const percentage = Math.round(clamped * 100);
  const barColor = color === 'auto' ? getAutoColor(clamped) : getNamedColor(color);
  const height = size === 'sm' ? '6px' : '10px';

  return (
    <div class="progress-bar" style={{ width: '100%' }}>
      {label && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--space-1)',
        }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
            {label}
          </span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
            {percentage}%
          </span>
        </div>
      )}
      <div style={{
        width: '100%',
        height,
        background: 'var(--color-bg)',
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden',
      }}>
        <div
          style={{
            width: `${percentage}%`,
            height: '100%',
            background: barColor,
            borderRadius: 'var(--radius-full)',
            transition: 'width 0.6s ease, background 0.3s ease',
          }}
        />
      </div>
    </div>
  );
}
