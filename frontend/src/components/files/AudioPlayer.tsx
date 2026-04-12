import { useState, useRef, useEffect, useCallback } from 'preact/hooks';

const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.flac', '.ogg', '.wav'];

export function isAudioFile(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

interface AudioPlayerProps {
  src: string;
  fileName: string;
  autoPlay?: boolean;
  onClose: () => void;
}

export function AudioPlayer({ src, fileName, autoPlay = false, onClose }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [seeking, setSeeking] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function onTimeUpdate() {
      if (!seeking) setCurrentTime(audio!.currentTime);
    }
    function onLoaded() {
      setDuration(audio!.duration);
      if (autoPlay) {
        audio!.play().then(() => setPlaying(true)).catch(() => {});
      }
    }
    function onEnded() {
      setPlaying(false);
    }

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('ended', onEnded);
      audio.pause();
    };
  }, [src, autoPlay, seeking]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => {});
    }
  }, [playing]);

  function handleSeek(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    setCurrentTime(val);
    if (audioRef.current) audioRef.current.currentTime = val;
    setSeeking(false);
  }

  function handleVolume(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    setVolume(val);
    if (audioRef.current) audioRef.current.volume = val;
  }

  function formatTime(seconds: number): string {
    if (!isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  return (
    <div class="audio-player">
      <audio ref={audioRef} src={src} preload="metadata" />

      <button class="audio-player__btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6,4 20,12 6,20" />
          </svg>
        )}
      </button>

      <div class="audio-player__info">
        <span class="audio-player__name truncate">{fileName}</span>
      </div>

      <span class="audio-player__time text-xs text-muted">{formatTime(currentTime)}</span>

      <input
        type="range"
        class="audio-player__seek"
        min={0}
        max={duration || 0}
        step={0.1}
        value={currentTime}
        onMouseDown={() => setSeeking(true)}
        onTouchStart={() => setSeeking(true)}
        onInput={handleSeek}
        aria-label="Seek"
      />

      <span class="audio-player__time text-xs text-muted">{formatTime(duration)}</span>

      <svg class="audio-player__vol-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
        <path d="M15.54 8.46a5 5 0 010 7.07" />
      </svg>

      <input
        type="range"
        class="audio-player__volume"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onInput={handleVolume}
        aria-label="Volume"
      />

      <button class="audio-player__btn audio-player__close" onClick={onClose} aria-label="Close player">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
