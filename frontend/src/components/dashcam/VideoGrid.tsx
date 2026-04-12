import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { DashcamClip, CameraAngle, ViewerLayout } from '../../api/types';
import type { PlaybackControls } from '../../hooks/useDashcamPlayback';
import { ALL_CAMERAS, CAMERA_LABELS } from '../../hooks/useDashcamPlayback';

interface VideoGridProps {
  clip: DashcamClip | null;
  layout: ViewerLayout;
  focusedCamera: CameraAngle;
  secondaryCamera: CameraAngle;
  onCameraFocus: (camera: CameraAngle) => void;
  controls: PlaybackControls;
}

interface VideoCellProps {
  camera: CameraAngle;
  src: string | null;
  onFocus: () => void;
  registerVideo: (camera: string, el: HTMLVideoElement | null) => void;
}

function VideoCell({ camera, src, onFocus, registerVideo }: VideoCellProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    registerVideo(camera, videoRef.current);
    return () => registerVideo(camera, null);
  }, [camera, registerVideo]);

  const handleWaiting = useCallback(() => setLoading(true), []);
  const handleCanPlay = useCallback(() => setLoading(false), []);
  const handleLoadedData = useCallback(() => setLoading(false), []);

  if (!src) {
    return (
      <div class="video-cell video-cell-empty">
        <div>
          <div class="video-cell-label">{CAMERA_LABELS[camera]}</div>
          <span>No video</span>
        </div>
      </div>
    );
  }

  return (
    <div class="video-cell">
      <div class="video-cell-label">{CAMERA_LABELS[camera]}</div>
      {loading && (
        <div class="video-cell-loading">
          <div class="spinner" />
        </div>
      )}
      <video
        ref={videoRef}
        src={src}
        preload="auto"
        playsInline
        muted
        onWaiting={handleWaiting}
        onCanPlay={handleCanPlay}
        onLoadedData={handleLoadedData}
      />
      <div class="video-cell-click-target" onClick={onFocus} />
    </div>
  );
}

export function VideoGrid({ clip, layout, focusedCamera, secondaryCamera, onCameraFocus, controls }: VideoGridProps) {
  if (!clip) {
    return (
      <div class="dashcam-empty-state">
        <div class="dashcam-empty-state-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M23 7l-7 5 7 5V7z" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </div>
        <p>Select an event from the list to begin playback</p>
      </div>
    );
  }

  const getVideoUrl = (camera: CameraAngle): string | null => {
    return clip.cameras[camera] ?? null;
  };

  // Determine which cameras to show based on layout
  const availableCameras = ALL_CAMERAS.filter(c => clip.cameras[c]);

  if (layout === 'single') {
    return (
      <div class={`video-grid-container layout-single`}>
        <VideoCell
          camera={focusedCamera}
          src={getVideoUrl(focusedCamera)}
          onFocus={() => {}}
          registerVideo={controls.registerVideo}
        />
      </div>
    );
  }

  if (layout === 'side-by-side') {
    return (
      <div class={`video-grid-container layout-side-by-side`}>
        <VideoCell
          camera={focusedCamera}
          src={getVideoUrl(focusedCamera)}
          onFocus={() => {}}
          registerVideo={controls.registerVideo}
        />
        <VideoCell
          camera={secondaryCamera}
          src={getVideoUrl(secondaryCamera)}
          onFocus={() => onCameraFocus(secondaryCamera)}
          registerVideo={controls.registerVideo}
        />
      </div>
    );
  }

  if (layout === 'picture-in-picture') {
    const pipSecondary = availableCameras.find(c => c !== focusedCamera) ?? 'back';
    return (
      <div class={`video-grid-container layout-picture-in-picture`}>
        <VideoCell
          camera={focusedCamera}
          src={getVideoUrl(focusedCamera)}
          onFocus={() => {}}
          registerVideo={controls.registerVideo}
        />
        <div class="video-cell pip-overlay" onClick={() => onCameraFocus(pipSecondary as CameraAngle)}>
          <VideoCell
            camera={pipSecondary as CameraAngle}
            src={getVideoUrl(pipSecondary as CameraAngle)}
            onFocus={() => onCameraFocus(pipSecondary as CameraAngle)}
            registerVideo={controls.registerVideo}
          />
        </div>
      </div>
    );
  }

  if (layout === 'front-focus') {
    const others = availableCameras.filter(c => c !== focusedCamera);
    return (
      <div class={`video-grid-container layout-front-focus`}>
        <VideoCell
          camera={focusedCamera}
          src={getVideoUrl(focusedCamera)}
          onFocus={() => {}}
          registerVideo={controls.registerVideo}
        />
        <div class="video-thumbnails-row">
          {others.map(cam => (
            <VideoCell
              key={cam}
              camera={cam}
              src={getVideoUrl(cam)}
              onFocus={() => onCameraFocus(cam)}
              registerVideo={controls.registerVideo}
            />
          ))}
        </div>
      </div>
    );
  }

  // Grid layouts: grid-2x3 or grid-3x2
  // Show all 6 camera slots (some may be empty)
  return (
    <div class={`video-grid-container layout-${layout}`}>
      {ALL_CAMERAS.map(cam => (
        <VideoCell
          key={cam}
          camera={cam}
          src={getVideoUrl(cam)}
          onFocus={() => onCameraFocus(cam)}
          registerVideo={controls.registerVideo}
        />
      ))}
    </div>
  );
}
