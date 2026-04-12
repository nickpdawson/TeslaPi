import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { DashcamClip, CameraAngle } from '../api/types';

/** All possible camera angles in render order. */
export const ALL_CAMERAS: CameraAngle[] = [
  'front',
  'left_repeater',
  'right_repeater',
  'left_pillar',
  'right_pillar',
  'back',
];

/** Human-readable labels for camera angles. */
export const CAMERA_LABELS: Record<CameraAngle, string> = {
  front: 'Front',
  left_repeater: 'Left Repeater',
  right_repeater: 'Right Repeater',
  left_pillar: 'Left Pillar',
  right_pillar: 'Right Pillar',
  back: 'Back',
};

export interface PlaybackState {
  playing: boolean;
  currentTime: number;
  duration: number;
  currentClipIndex: number;
  playbackRate: number;
  buffering: Set<string>;
}

export interface PlaybackControls {
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  nextClip: () => void;
  prevClip: () => void;
  setRate: (rate: number) => void;
  skipForward: (seconds?: number) => void;
  skipBack: (seconds?: number) => void;
  registerVideo: (camera: string, el: HTMLVideoElement | null) => void;
}

const DEFAULT_CLIP_DURATION = 60;
const SYNC_INTERVAL = 500;
const SYNC_THRESHOLD = 0.2;

export function useDashcamPlayback(clips: DashcamClip[]): [PlaybackState, PlaybackControls] {
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seekingRef = useRef(false);
  const masterTimeRef = useRef(0);

  const [state, setState] = useState<PlaybackState>({
    playing: false,
    currentTime: 0,
    duration: 0,
    currentClipIndex: 0,
    playbackRate: 1,
    buffering: new Set(),
  });

  // Calculate total duration and clip boundaries
  const clipDurations = clips.map(c => c.duration ?? DEFAULT_CLIP_DURATION);
  const totalDuration = clipDurations.reduce((sum, dur) => sum + dur, 0);
  const clipStartTimes = clipDurations.reduce<number[]>((acc, _dur, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + clipDurations[i - 1]);
    return acc;
  }, []);

  // Update duration when clips change
  useEffect(() => {
    setState(prev => ({ ...prev, duration: totalDuration, currentTime: 0, currentClipIndex: 0, playing: false }));
    masterTimeRef.current = 0;
  }, [clips.length, totalDuration]);

  // Find which clip index a global time belongs to
  const getClipIndexForTime = useCallback((time: number): number => {
    for (let i = clipStartTimes.length - 1; i >= 0; i--) {
      if (time >= clipStartTimes[i]) return i;
    }
    return 0;
  }, [clipStartTimes]);

  // Get time within the current clip
  const getLocalTime = useCallback((globalTime: number, clipIndex: number): number => {
    return globalTime - (clipStartTimes[clipIndex] ?? 0);
  }, [clipStartTimes]);

  const getAllVideos = useCallback((): HTMLVideoElement[] => {
    return Array.from(videoRefs.current.values());
  }, []);

  const registerVideo = useCallback((camera: string, el: HTMLVideoElement | null) => {
    if (el) {
      videoRefs.current.set(camera, el);
    } else {
      videoRefs.current.delete(camera);
    }
  }, []);

  // Set playback rate on all videos
  const applyRate = useCallback((rate: number) => {
    getAllVideos().forEach(v => {
      v.playbackRate = rate;
    });
  }, [getAllVideos]);

  // Sync all videos to the master time
  const syncVideos = useCallback(() => {
    if (seekingRef.current || clips.length === 0) return;

    const clipIdx = getClipIndexForTime(masterTimeRef.current);
    const localTime = getLocalTime(masterTimeRef.current, clipIdx);

    videoRefs.current.forEach((video) => {
      const drift = Math.abs(video.currentTime - localTime);
      if (drift > SYNC_THRESHOLD && !video.seeking) {
        video.currentTime = localTime;
      }
    });
  }, [clips.length, getClipIndexForTime, getLocalTime]);

  // Start sync timer
  const startSyncTimer = useCallback(() => {
    if (syncTimerRef.current) clearInterval(syncTimerRef.current);
    syncTimerRef.current = setInterval(() => {
      // Update master time from first available video
      const videos = getAllVideos();
      if (videos.length > 0 && !seekingRef.current) {
        const clipIdx = state.currentClipIndex;
        const base = clipStartTimes[clipIdx] ?? 0;
        masterTimeRef.current = base + (videos[0].currentTime || 0);

        setState(prev => ({
          ...prev,
          currentTime: masterTimeRef.current,
        }));
      }
      syncVideos();
    }, SYNC_INTERVAL);
  }, [getAllVideos, syncVideos, state.currentClipIndex, clipStartTimes]);

  const stopSyncTimer = useCallback(() => {
    if (syncTimerRef.current) {
      clearInterval(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopSyncTimer();
  }, [stopSyncTimer]);

  const play = useCallback(() => {
    const videos = getAllVideos();
    const playPromises = videos.map(v => {
      v.playbackRate = state.playbackRate;
      return v.play().catch(() => { /* ignore autoplay block */ });
    });
    Promise.all(playPromises).then(() => {
      setState(prev => ({ ...prev, playing: true }));
      startSyncTimer();
    });
  }, [getAllVideos, state.playbackRate, startSyncTimer]);

  const pause = useCallback(() => {
    getAllVideos().forEach(v => v.pause());
    stopSyncTimer();
    setState(prev => ({ ...prev, playing: false }));
  }, [getAllVideos, stopSyncTimer]);

  const togglePlay = useCallback(() => {
    if (state.playing) {
      pause();
    } else {
      play();
    }
  }, [state.playing, play, pause]);

  const seek = useCallback((time: number) => {
    const clamped = Math.max(0, Math.min(time, totalDuration));
    const clipIdx = getClipIndexForTime(clamped);
    const localTime = getLocalTime(clamped, clipIdx);

    seekingRef.current = true;
    masterTimeRef.current = clamped;

    // If we need to change clips, update the index which will trigger re-render with new sources
    const needsClipChange = clipIdx !== state.currentClipIndex;

    getAllVideos().forEach(v => {
      v.pause();
      v.currentTime = localTime;
    });

    setState(prev => ({
      ...prev,
      currentTime: clamped,
      currentClipIndex: clipIdx,
    }));

    // Wait for seeks to complete
    const videos = getAllVideos();
    if (videos.length === 0) {
      seekingRef.current = false;
      return;
    }

    let pendingSeeked = videos.length;
    const onSeeked = () => {
      pendingSeeked--;
      if (pendingSeeked <= 0) {
        seekingRef.current = false;
        videos.forEach(v => v.removeEventListener('seeked', onSeeked));
        if (state.playing && !needsClipChange) {
          play();
        }
      }
    };

    videos.forEach(v => {
      v.addEventListener('seeked', onSeeked, { once: true });
    });

    // Safety timeout
    setTimeout(() => {
      seekingRef.current = false;
      videos.forEach(v => v.removeEventListener('seeked', onSeeked));
    }, 2000);
  }, [totalDuration, getClipIndexForTime, getLocalTime, getAllVideos, state.currentClipIndex, state.playing, play]);

  const nextClip = useCallback(() => {
    const nextIdx = state.currentClipIndex + 1;
    if (nextIdx < clips.length) {
      seek(clipStartTimes[nextIdx]);
    }
  }, [state.currentClipIndex, clips.length, clipStartTimes, seek]);

  const prevClip = useCallback(() => {
    const prevIdx = state.currentClipIndex - 1;
    if (prevIdx >= 0) {
      seek(clipStartTimes[prevIdx]);
    } else {
      seek(0);
    }
  }, [state.currentClipIndex, clipStartTimes, seek]);

  const setRate = useCallback((rate: number) => {
    applyRate(rate);
    setState(prev => ({ ...prev, playbackRate: rate }));
  }, [applyRate]);

  const skipForward = useCallback((seconds = 10) => {
    seek(masterTimeRef.current + seconds);
  }, [seek]);

  const skipBack = useCallback((seconds = 10) => {
    seek(masterTimeRef.current - seconds);
  }, [seek]);

  // Handle clip ended: auto-advance to next clip
  useEffect(() => {
    const videos = getAllVideos();
    const onEnded = () => {
      const nextIdx = state.currentClipIndex + 1;
      if (nextIdx < clips.length) {
        setState(prev => ({ ...prev, currentClipIndex: nextIdx }));
        masterTimeRef.current = clipStartTimes[nextIdx];
      } else {
        pause();
        setState(prev => ({ ...prev, currentTime: totalDuration }));
      }
    };

    videos.forEach(v => v.addEventListener('ended', onEnded));
    return () => {
      videos.forEach(v => v.removeEventListener('ended', onEnded));
    };
  }, [getAllVideos, state.currentClipIndex, clips.length, clipStartTimes, totalDuration, pause]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Don't intercept if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          skipBack(e.shiftKey ? 30 : 10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          skipForward(e.shiftKey ? 30 : 10);
          break;
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [togglePlay, skipBack, skipForward]);

  return [
    { ...state, duration: totalDuration },
    {
      play,
      pause,
      togglePlay,
      seek,
      nextClip,
      prevClip,
      setRate,
      skipForward,
      skipBack,
      registerVideo,
    },
  ];
}
