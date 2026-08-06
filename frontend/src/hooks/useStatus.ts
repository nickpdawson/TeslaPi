import { useEffect, useState } from 'preact/hooks';
import { get } from '../api/client';
import { status, connected } from '../stores/appState';
import type { TeslaPiStatus } from '../api/types';

const POLL_INTERVAL = 5000;

/** Format seconds into a human-readable string like "2d 16h 35m" or "16h 35m" */
function formatUptime(seconds: number): string {
  if (seconds <= 0) return '0m';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

/** Map snake_case API response to camelCase frontend types */
export function transformStatus(raw: Record<string, unknown>): TeslaPiStatus {
  const sys = (raw.system ?? {}) as Record<string, unknown>;
  const arch = (raw.archive ?? {}) as Record<string, unknown>;
  const mus = (raw.music ?? {}) as Record<string, unknown>;
  const gad = (raw.gadget ?? {}) as Record<string, unknown>;
  const storageRaw = (raw.storage ?? []) as Record<string, unknown>[];
  const eventsRaw = (raw.dashcam ?? []) as Record<string, unknown>[];

  const uptimeSeconds = Number(sys.uptime_seconds ?? 0);

  return {
    state: (String(raw.state ?? 'idle')) as TeslaPiStatus['state'],
    system: {
      uptime: uptimeSeconds > 0 ? formatUptime(uptimeSeconds) : String(sys.uptime ?? '0m'),
      cpuTemp: Number(sys.cpu_temp_celsius ?? sys.cpuTemp ?? 0),
      cpuUsage: Number(sys.cpu_usage ?? sys.cpuUsage ?? 0),
      memoryUsed: Number(sys.ram_used_bytes ?? sys.memoryUsed ?? 0),
      memoryTotal: Number(sys.ram_total_bytes ?? sys.memoryTotal ?? 0),
      wifiSignal: Number(sys.wifi_signal_dbm ?? sys.wifiSignal ?? 0),
      ipAddress: String(sys.ip_address ?? sys.ipAddress ?? ''),
      hostname: String(sys.hostname ?? ''),
    },
    storage: storageRaw.map((s) => ({
      drive: String(s.drive ?? s.mount_point ?? s.name ?? ''),
      label: String(s.label ?? s.drive ?? s.name ?? ''),
      usedBytes: Number(s.used_bytes ?? s.usedBytes ?? 0),
      totalBytes: Number(s.total_bytes ?? s.totalBytes ?? 0),
      mountpoint: String(s.mount_point ?? s.mountpoint ?? ''),
      filesystem: String(s.filesystem ?? ''),
      healthy: Boolean(s.healthy ?? true),
    })),
    gadget: {
      enabled: Boolean(gad.enabled ?? false),
      drives: (gad.drives ?? []) as string[],
    },
    archive: {
      serverReachable: Boolean(arch.server_reachable ?? arch.serverReachable ?? false),
      serverName: String(arch.server_name ?? arch.serverName ?? ''),
      lastArchiveTime: (arch.last_archive_at ?? arch.lastArchiveTime ?? null) as string | null,
      lastArchiveClips: Number(arch.last_archive_clips ?? arch.lastArchiveClips ?? 0),
      lastArchiveSize: Number(arch.last_archive_bytes ?? arch.lastArchiveSize ?? 0),
      nextAction: String(arch.next_archive ?? arch.nextAction ?? ''),
      status: String(arch.status ?? 'idle') as 'idle' | 'archiving' | 'error' | 'unreachable',
    },
    music: {
      artistsSynced: Number(mus.total_artists ?? mus.artistsSynced ?? 0),
      lastSyncTime: (mus.last_sync_at ?? mus.lastSyncTime ?? null) as string | null,
      status: (mus.sync_in_progress ? 'syncing' : (mus.status ?? 'idle')) as 'idle' | 'syncing' | 'error' | 'indexing',
    },
    dashcamEvents: eventsRaw.map((e) => ({
      id: String(e.id ?? ''),
      type: String(e.type ?? 'saved') as 'sentry' | 'saved' | 'recent' | 'track',
      timestamp: String(e.timestamp ?? ''),
      cameras: (e.cameras ?? []) as string[],
      archived: Boolean(e.archived ?? false),
    })),
  };
}

export function useStatus() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    async function fetchStatus() {
      try {
        const raw = await get<Record<string, unknown>>('/status');
        if (!cancelled) {
          status.value = transformStatus(raw);
          connected.value = true;
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          connected.value = false;
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      }
    }

    function schedulePoll() {
      if (cancelled) return;
      timer = setTimeout(async () => {
        await fetchStatus();
        schedulePoll();
      }, POLL_INTERVAL);
    }

    // Page Visibility API: pause polling when tab hidden
    function handleVisibility() {
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else {
        // Resume immediately
        fetchStatus().then(() => {
          if (!cancelled) schedulePoll();
        });
      }
    }

    // Initial fetch
    fetchStatus().then(() => {
      if (!cancelled) schedulePoll();
    });

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  return { loading, error };
}
