import { useCallback, useRef, useState } from 'preact/hooks';
import type { DashcamEventDetail, CameraAngle, ViewerLayout } from '../../api/types';
import { useDashcamPlayback, ALL_CAMERAS, CAMERA_LABELS } from '../../hooks/useDashcamPlayback';
import { VideoGrid } from './VideoGrid';
import { Timeline } from './Timeline';
import { PlaybackControls } from './PlaybackControls';
import { LayoutSelector } from './LayoutSelector';

const LAYOUT_STORAGE_KEY = 'teslapi-dashcam-layout';

function getStoredLayout(): ViewerLayout {
  try {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored) return stored as ViewerLayout;
  } catch { /* ignore */ }
  return 'front-focus';
}

interface DashcamViewerProps {
  event: DashcamEventDetail | null;
}

export function DashcamViewer({ event }: DashcamViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<ViewerLayout>(getStoredLayout);
  const [focusedCamera, setFocusedCamera] = useState<CameraAngle>('front');
  const [secondaryCamera, setSecondaryCamera] = useState<CameraAngle>('back');

  const clips = event?.clips ?? [];
  const [playbackState, playbackControls] = useDashcamPlayback(clips);

  const currentClip = clips[playbackState.currentClipIndex] ?? null;

  const handleLayoutChange = useCallback((newLayout: ViewerLayout) => {
    setLayout(newLayout);
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, newLayout);
    } catch { /* ignore */ }
  }, []);

  const handleCameraFocus = useCallback((camera: CameraAngle) => {
    setSecondaryCamera(focusedCamera);
    setFocusedCamera(camera);
  }, [focusedCamera]);

  const handleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      containerRef.current.requestFullscreen().catch(() => {});
    }
  }, []);

  const handleDownload = useCallback(() => {
    if (!currentClip) return;
    const frontUrl = currentClip.cameras['front'] ?? Object.values(currentClip.cameras)[0];
    if (frontUrl) {
      const a = document.createElement('a');
      a.href = frontUrl;
      a.download = '';
      a.click();
    }
  }, [currentClip]);

  // Determine available cameras for camera selector (single/side-by-side)
  const availableCameras = currentClip
    ? ALL_CAMERAS.filter(c => currentClip.cameras[c])
    : [];

  const showCameraSelector = layout === 'single' || layout === 'side-by-side';

  return (
    <div class="dashcam-main" ref={containerRef}>
      {/* Layout selector bar */}
      <LayoutSelector layout={layout} onLayoutChange={handleLayoutChange} />

      {/* Camera selector for single/side-by-side modes */}
      {showCameraSelector && currentClip && (
        <div class="camera-selector">
          {availableCameras.map(cam => (
            <button
              key={cam}
              class={`camera-selector-btn${cam === focusedCamera ? ' active' : ''}`}
              onClick={() => handleCameraFocus(cam)}
            >
              {CAMERA_LABELS[cam]}
            </button>
          ))}
        </div>
      )}

      {/* Video grid */}
      <VideoGrid
        clip={currentClip}
        layout={layout}
        focusedCamera={focusedCamera}
        secondaryCamera={secondaryCamera}
        onCameraFocus={handleCameraFocus}
        controls={playbackControls}
      />

      {/* Timeline and controls (only when event is loaded) */}
      {event && (
        <>
          <Timeline
            state={playbackState}
            clips={clips}
            onSeek={playbackControls.seek}
            sentryTriggerTime={event.type === 'sentry' ? 60 : undefined}
          />
          <PlaybackControls
            state={playbackState}
            controls={playbackControls}
            clipCount={clips.length}
            onFullscreen={handleFullscreen}
            onDownload={handleDownload}
          />
        </>
      )}
    </div>
  );
}
