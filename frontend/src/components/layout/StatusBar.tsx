import { connected, status } from '../../stores/appState';

export function StatusBar() {
  const isConnected = connected.value;
  const archiveStatus = status.value?.archive?.status;

  let color = 'var(--color-error)';
  let label = 'Offline';
  let pulsing = false;

  if (isConnected) {
    if (archiveStatus === 'archiving') {
      color = 'var(--color-warning)';
      label = 'Archiving...';
      pulsing = true;
    } else {
      color = 'var(--color-success)';
      label = 'Connected';
    }
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      marginRight: 'var(--space-4)',
    }}>
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
          marginRight: 'var(--space-2)',
          animation: pulsing ? 'pulse 2s ease-in-out infinite' : 'none',
          boxShadow: `0 0 6px ${color}`,
        }}
      />
      <span style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--color-text-muted)',
        fontWeight: 'var(--font-weight-medium)',
      }}>
        {label}
      </span>
    </div>
  );
}
