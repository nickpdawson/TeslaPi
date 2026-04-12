import { useCallback, useRef } from 'preact/hooks';
import type { DashcamClip } from '../../api/types';
import type { PlaybackState } from '../../hooks/useDashcamPlayback';

interface TimelineProps {
  state: PlaybackState;
  clips: DashcamClip[];
  onSeek: (time: number) => void;
  sentryTriggerTime?: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function Timeline({ state, clips, onSeek, sentryTriggerTime }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const clipDurations = clips.map(c => c.duration ?? 60);
  const totalDuration = state.duration || 1;

  // Compute clip boundary positions as fractions
  const clipBoundaries: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < clipDurations.length - 1; i++) {
    cumulative += clipDurations[i];
    clipBoundaries.push(cumulative / totalDuration);
  }

  const progress = totalDuration > 0 ? (state.currentTime / totalDuration) * 100 : 0;

  const getTimeFromEvent = useCallback((e: MouseEvent | TouchEvent) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return fraction * totalDuration;
  }, [totalDuration]);

  const handlePointerDown = useCallback((e: MouseEvent) => {
    draggingRef.current = true;
    const time = getTimeFromEvent(e);
    onSeek(time);

    const handleMove = (me: MouseEvent) => {
      if (draggingRef.current) {
        const t = getTimeFromEvent(me);
        onSeek(t);
      }
    };

    const handleUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [getTimeFromEvent, onSeek]);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const time = getTimeFromEvent(e);
    onSeek(time);
  }, [getTimeFromEvent, onSeek]);

  return (
    <div class="dashcam-timeline">
      <div
        class="timeline-bar-container"
        onMouseDown={handlePointerDown}
        onTouchStart={handleTouchStart}
        ref={trackRef}
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={totalDuration}
        aria-valuenow={state.currentTime}
        tabIndex={0}
      >
        <div class="timeline-bar-track">
          <div
            class="timeline-bar-progress"
            style={{ width: `${progress}%` }}
          />
          {clipBoundaries.map((pos, i) => (
            <div
              key={i}
              class="timeline-clip-divider"
              style={{ left: `${pos * 100}%` }}
            />
          ))}
          {sentryTriggerTime !== undefined && (
            <div
              class="timeline-sentry-marker"
              style={{ left: `${(sentryTriggerTime / totalDuration) * 100}%` }}
              title="Sentry trigger"
            />
          )}
        </div>
      </div>
      <div class="timeline-time">
        <span>{formatTime(state.currentTime)}</span>
        <span>
          Clip {state.currentClipIndex + 1}/{clips.length}
        </span>
        <span>{formatTime(totalDuration)}</span>
      </div>
    </div>
  );
}
