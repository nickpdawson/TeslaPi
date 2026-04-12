import { Card } from '../common/Card';
import type { DashcamEvent } from '../../api/types';

interface DashcamCardProps {
  events: DashcamEvent[];
}

function formatRelativeTime(isoString: string): string {
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

function TypeIcon({ type }: { type: DashcamEvent['type'] }) {
  if (type === 'sentry') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    );
  }
  if (type === 'saved') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
      </svg>
    );
  }
  // recent / track
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function typeLabel(type: DashcamEvent['type']): string {
  switch (type) {
    case 'sentry': return 'Sentry Event';
    case 'saved': return 'Saved Clip';
    case 'recent': return 'Recent';
    case 'track': return 'Track Mode';
    default: return 'Recording';
  }
}

function CamIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

export function DashcamCard({ events }: DashcamCardProps) {
  return (
    <Card title="Dashcam" icon={<CamIcon />}>
      {events.length === 0 ? (
        <div class="empty-state">
          <CamIcon />
          <p class="empty-state__text" style={{ marginTop: 'var(--space-3)' }}>No recent recordings</p>
        </div>
      ) : (
        <div>
          {events.slice(0, 5).map((event, i) => (
            <div
              key={event.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: 'var(--space-3) 0',
                borderBottom: i < events.length - 1 ? '1px solid var(--color-border)' : 'none',
              }}
            >
              <span style={{
                color: event.type === 'sentry' ? 'var(--color-warning)' : 'var(--color-accent)',
                marginRight: 'var(--space-3)',
                flexShrink: 0,
              }}>
                <TypeIcon type={event.type} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 'var(--text-sm)',
                  fontWeight: 'var(--font-weight-medium)',
                }}>
                  {typeLabel(event.type)}
                </div>
                <div style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--color-text-muted)',
                }}>
                  {event.cameras.length} cameras
                </div>
              </div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}>
                {event.archived && (
                  <span style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--color-success)',
                    marginRight: 'var(--space-2)',
                  }} title="Archived">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
                <span style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--color-text-muted)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {formatRelativeTime(event.timestamp)}
                </span>
              </div>
            </div>
          ))}

          {events.length > 0 && (
            <div style={{ marginTop: 'var(--space-3)', textAlign: 'center' }}>
              <a href="/dashcam" class="btn btn--ghost btn--sm" style={{ textDecoration: 'none' }}>
                View All
              </a>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
