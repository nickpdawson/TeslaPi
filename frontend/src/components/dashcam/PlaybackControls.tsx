import type { PlaybackState, PlaybackControls as Controls } from '../../hooks/useDashcamPlayback';

interface PlaybackControlsProps {
  state: PlaybackState;
  controls: Controls;
  clipCount: number;
  onFullscreen: () => void;
  onDownload: () => void;
}

export function PlaybackControls({ state, controls, clipCount, onFullscreen, onDownload }: PlaybackControlsProps) {
  const speeds = [0.5, 1, 1.5, 2];

  return (
    <div class="playback-controls">
      {/* Left group: clip nav */}
      <button
        class="playback-btn"
        onClick={controls.prevClip}
        disabled={state.currentClipIndex <= 0}
        title="Previous clip"
        aria-label="Previous clip"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
        </svg>
      </button>

      {/* Skip back */}
      <button
        class="playback-btn"
        onClick={() => controls.skipBack(10)}
        title="Back 10s"
        aria-label="Skip back 10 seconds"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 4v6h6" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          <text x="12" y="16" fill="currentColor" stroke="none" font-size="8" text-anchor="middle" font-family="sans-serif">10</text>
        </svg>
      </button>

      {/* Play/Pause */}
      <button
        class="playback-btn primary"
        onClick={controls.togglePlay}
        title={state.playing ? 'Pause (Space)' : 'Play (Space)'}
        aria-label={state.playing ? 'Pause' : 'Play'}
      >
        {state.playing ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7L8 5z" />
          </svg>
        )}
      </button>

      {/* Skip forward */}
      <button
        class="playback-btn"
        onClick={() => controls.skipForward(10)}
        title="Forward 10s"
        aria-label="Skip forward 10 seconds"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 4v6h-6" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          <text x="12" y="16" fill="currentColor" stroke="none" font-size="8" text-anchor="middle" font-family="sans-serif">10</text>
        </svg>
      </button>

      {/* Next clip */}
      <button
        class="playback-btn"
        onClick={controls.nextClip}
        disabled={state.currentClipIndex >= clipCount - 1}
        title="Next clip"
        aria-label="Next clip"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z" />
        </svg>
      </button>

      <div class="controls-spacer" />

      {/* Speed */}
      <select
        class="playback-speed-select"
        value={state.playbackRate}
        onChange={(e) => controls.setRate(Number((e.target as HTMLSelectElement).value))}
        aria-label="Playback speed"
      >
        {speeds.map(s => (
          <option key={s} value={s}>{s}x</option>
        ))}
      </select>

      {/* Download */}
      <button
        class="playback-btn"
        onClick={onDownload}
        title="Download current clip"
        aria-label="Download current clip"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>

      {/* Fullscreen */}
      <button
        class="playback-btn"
        onClick={onFullscreen}
        title="Fullscreen"
        aria-label="Toggle fullscreen"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
          <line x1="21" y1="3" x2="14" y2="10" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      </button>
    </div>
  );
}
