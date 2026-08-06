import { useCallback, useState } from 'preact/hooks';
import { get } from '../../api/client';
import type { DashcamEvent, DashcamEventDetail } from '../../api/types';
import { EventList } from './EventList';
import { DashcamViewer } from './DashcamViewer';

interface DashcamPageProps {
  path?: string;
}

export function DashcamPage({}: DashcamPageProps) {
  const [selectedEvent, setSelectedEvent] = useState<DashcamEventDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [mobileTab, setMobileTab] = useState<'events' | 'viewer'>('events');

  const handleSelectEvent = useCallback(async (event: DashcamEvent) => {
    setSelectedId(event.id);
    setLoadingDetail(true);
    setMobileTab('viewer');

    try {
      const detail = await get<DashcamEventDetail>(`/dashcam/events/${event.id}`);
      setSelectedEvent(detail);
    } catch (err) {
      console.error('Failed to load event detail:', err);
      setSelectedEvent(null);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  return (
    <div class="dashcam-page">
      {/* Mobile tab bar */}
      <div class="dashcam-mobile-tabs">
        <button
          class={mobileTab === 'events' ? 'active' : ''}
          onClick={() => setMobileTab('events')}
        >
          Events
        </button>
        <button
          class={mobileTab === 'viewer' ? 'active' : ''}
          onClick={() => setMobileTab('viewer')}
        >
          Viewer
        </button>
      </div>

      {/* Event list sidebar */}
      <div class={`dashcam-sidebar${mobileTab !== 'events' ? ' hidden-mobile' : ''}`}>
        <EventList
          selectedId={selectedId}
          onSelect={handleSelectEvent}
        />
      </div>

      {/* Viewer area — always keep dashcam-main; hide only on mobile when the events
          tab is active (hidden-mobile is inside a max-width media query). The old
          inline display:none applied at ALL widths, hiding the viewer on desktop. */}
      <div class={`dashcam-main${mobileTab !== 'viewer' ? ' hidden-mobile' : ''}`}>
        {loadingDetail ? (
          <div class="dashcam-empty-state">
            <div class="spinner" style={{ width: '40px', height: '40px', border: '3px solid rgba(255,255,255,0.1)', borderTopColor: 'rgba(255,255,255,0.6)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <p style={{ marginTop: '16px' }}>Loading event...</p>
          </div>
        ) : (
          <DashcamViewer event={selectedEvent} />
        )}
      </div>
    </div>
  );
}
