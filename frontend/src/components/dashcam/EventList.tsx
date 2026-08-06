import { useCallback, useEffect, useState } from 'preact/hooks';
import { get } from '../../api/client';
import type { DashcamEvent } from '../../api/types';

const TYPE_ICONS: Record<string, string> = {
  sentry: '\u{1F6E1}',   // shield
  saved: '\u{1F4BE}',    // floppy
  recent: '\u{1F551}',   // clock
  track: '\u{1F3CE}',    // racing car
};

const TYPE_LABELS: Record<string, string> = {
  sentry: 'Sentry',
  saved: 'Saved',
  recent: 'Recent',
  track: 'Track',
};

const FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'sentry', label: 'Sentry' },
  { value: 'saved', label: 'Saved' },
  { value: 'recent', label: 'Recent' },
  { value: 'track', label: 'Track' },
];

interface EventListProps {
  selectedId: string | null;
  onSelect: (event: DashcamEvent) => void;
}

function formatDateGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const eventDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (eventDate.getTime() === today.getTime()) return 'Today';
  if (eventDate.getTime() === yesterday.getTime()) return 'Yesterday';

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function groupByDate(events: DashcamEvent[]): Map<string, DashcamEvent[]> {
  const groups = new Map<string, DashcamEvent[]>();
  for (const ev of events) {
    const dateKey = ev.timestamp.split('T')[0];
    const group = groups.get(dateKey) ?? [];
    group.push(ev);
    groups.set(dateKey, group);
  }
  return groups;
}

export function EventList({ selectedId, onSelect }: EventListProps) {
  const [events, setEvents] = useState<DashcamEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      const params = filter ? `?type=${filter}` : '';
      const data = await get<DashcamEvent[]>(`/dashcam/events${params}`);
      // Map backend response to DashcamEvent shape
      setEvents(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const grouped = groupByDate(events);

  return (
    <>
      <div class="event-list-header">
        <h2>Dashcam Events</h2>
        <div class="event-filter-bar">
          {FILTER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              class={`event-filter-btn${filter === opt.value ? ' active' : ''}`}
              onClick={() => setFilter(opt.value)}
              aria-pressed={filter === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div class="event-list">
        {loading && (
          <div class="p-4 text-center text-muted">
            <div class="skeleton" style={{ height: '48px', marginBottom: '8px' }} />
            <div class="skeleton" style={{ height: '48px', marginBottom: '8px' }} />
            <div class="skeleton" style={{ height: '48px' }} />
          </div>
        )}
        {error && (
          <div class="p-4 text-center text-error text-sm">{error}</div>
        )}
        {!loading && !error && events.length === 0 && (
          <div class="p-4 text-center text-muted text-sm">No events found</div>
        )}
        {!loading && Array.from(grouped.entries()).map(([dateKey, group]) => (
          <div key={dateKey} class="event-date-group">
            <div class="event-date-label">{formatDateGroup(group[0].timestamp)}</div>
            {group.map(ev => (
              <div
                key={ev.id}
                class={`event-item${selectedId === ev.id ? ' active' : ''}`}
                onClick={() => onSelect(ev)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onSelect(ev); }}
              >
                <div class={`event-type-icon ${ev.type}`}>
                  {TYPE_ICONS[ev.type] ?? '?'}
                </div>
                <div class="event-info">
                  <div class="event-time">
                    {formatTime(ev.timestamp)}
                  </div>
                  <div class="event-meta">
                    <span>{TYPE_LABELS[ev.type] ?? ev.type}</span>
                    <span>{ev.cameras.length} cameras</span>
                    {ev.archived && (
                      <span class="event-badge archived">Archived</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
