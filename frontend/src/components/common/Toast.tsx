import { notifications, removeNotification, type Notification } from '../../stores/appState';

function getTypeStyles(type: Notification['type']): { bg: string; border: string; icon: string } {
  switch (type) {
    case 'success':
      return { bg: 'var(--color-success-glow)', border: 'var(--color-success)', icon: '\u2713' };
    case 'error':
      return { bg: 'var(--color-error-glow)', border: 'var(--color-error)', icon: '\u2717' };
    case 'warning':
      return { bg: 'var(--color-warning-glow)', border: 'var(--color-warning)', icon: '!' };
    case 'info':
    default:
      return { bg: 'var(--color-accent-glow)', border: 'var(--color-accent)', icon: 'i' };
  }
}

function ToastItem({ notification }: { notification: Notification }) {
  const styles = getTypeStyles(notification.type);
  // Errors/warnings interrupt (assertive); success/info wait for a pause (polite).
  const assertive = notification.type === 'error' || notification.type === 'warning';

  return (
    <div
      role={assertive ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--color-card)',
        border: `1px solid ${styles.border}`,
        borderLeft: `4px solid ${styles.border}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        animation: 'slide-in-right 0.3s ease forwards',
        minWidth: '280px',
        maxWidth: '400px',
        transition: 'opacity var(--transition-base)',
      }}
    >
      <span aria-hidden="true" style={{
        width: '24px',
        height: '24px',
        borderRadius: '50%',
        background: styles.bg,
        color: styles.border,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 'var(--text-xs)',
        fontWeight: 'var(--font-weight-bold)',
        flexShrink: 0,
        marginRight: 'var(--space-3)',
      }}>
        {styles.icon}
      </span>
      <span style={{
        fontSize: 'var(--text-sm)',
        color: 'var(--color-text)',
        flex: 1,
      }}>
        {notification.message}
      </span>
      <button
        onClick={() => removeNotification(notification.id)}
        aria-label="Dismiss notification"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
          fontSize: '20px',
          lineHeight: 1,
          marginLeft: 'var(--space-3)',
          padding: 'var(--space-1)',
          flexShrink: 0,
        }}
      >
        &times;
      </button>
    </div>
  );
}

export function ToastContainer() {
  const items = notifications.value;
  if (items.length === 0) return null;

  return (
    <div class="toast-container" role="region" aria-label="Notifications">
      {items.map(n => (
        <ToastItem key={n.id} notification={n} />
      ))}
    </div>
  );
}
