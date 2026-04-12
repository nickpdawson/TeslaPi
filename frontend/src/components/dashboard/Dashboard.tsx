import { useStatus } from '../../hooks/useStatus';
import { status as statusSignal } from '../../stores/appState';
import { Skeleton } from '../common/Skeleton';
import { StatusHero } from './StatusHero';
import { StorageCard } from './StorageCard';
import { DashcamCard } from './DashcamCard';
import { MusicCard } from './MusicCard';
import { ArchiveCard } from './ArchiveCard';
import { NetworkCard } from './NetworkCard';
import { SystemCard } from './SystemCard';
import type { TeslaPiStatus } from '../../api/types';

interface DashboardProps {
  path?: string;
}

const mockStatus: TeslaPiStatus = {
  system: {
    uptime: '4d 12h 33m',
    cpuTemp: 48.2,
    cpuUsage: 12,
    memoryUsed: 412000000,
    memoryTotal: 4000000000,
    wifiSignal: -42,
    ipAddress: '192.168.1.50',
    hostname: 'teslapi',
  },
  storage: [
    { drive: 'cam', label: 'Dashcam', usedBytes: 112e9, totalBytes: 140e9, mountpoint: '/mnt/cam', filesystem: 'exfat', healthy: true },
    { drive: 'music', label: 'Music', usedBytes: 1.7e12, totalBytes: 1.8e12, mountpoint: '/mnt/music', filesystem: 'exfat', healthy: true },
    { drive: 'lightshow', label: 'Light Show', usedBytes: 0.2e9, totalBytes: 1e9, mountpoint: '/mnt/lightshow', filesystem: 'exfat', healthy: true },
    { drive: 'boombox', label: 'Boombox', usedBytes: 45e6, totalBytes: 100e6, mountpoint: '/mnt/boombox', filesystem: 'exfat', healthy: true },
    { drive: 'external', label: 'External Drive', usedBytes: 1.9e12, totalBytes: 2e12, mountpoint: '/dev/sda', filesystem: 'ext4', healthy: true },
  ],
  gadget: { enabled: true, drives: ['cam', 'music', 'lightshow', 'boombox'] },
  archive: {
    serverReachable: true,
    serverName: 'your-nas.local',
    lastArchiveTime: new Date(Date.now() - 120000).toISOString(),
    lastArchiveClips: 47,
    lastArchiveSize: 12.3e9,
    nextAction: 'waiting for idle',
    status: 'idle',
  },
  music: {
    artistsSynced: 847,
    lastSyncTime: new Date(Date.now() - 86400000).toISOString(),
    status: 'idle',
  },
  dashcamEvents: [
    { id: '1', type: 'sentry', timestamp: new Date(Date.now() - 7200000).toISOString(), cameras: ['front', 'left_repeater', 'right_repeater', 'back'], archived: true },
    { id: '2', type: 'saved', timestamp: new Date(Date.now() - 43200000).toISOString(), cameras: ['front', 'left_repeater', 'right_repeater', 'back'], archived: true },
    { id: '3', type: 'sentry', timestamp: new Date(Date.now() - 86400000).toISOString(), cameras: ['front', 'left_repeater', 'right_repeater', 'back'], archived: false },
  ],
};

function DashboardSkeleton() {
  return (
    <div class="container">
      {/* Hero skeleton */}
      <div class="card card--full" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-8)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Skeleton variant="circle" width="100px" height="100px" />
          <div style={{ marginTop: 'var(--space-6)', display: 'flex', width: '100%', justifyContent: 'center' }}>
            <div style={{ padding: '0 var(--space-6)' }}>
              <Skeleton width="60px" height="12px" />
              <div style={{ marginTop: 'var(--space-2)' }}><Skeleton width="80px" height="24px" /></div>
            </div>
            <div style={{ padding: '0 var(--space-6)' }}>
              <Skeleton width="60px" height="12px" />
              <div style={{ marginTop: 'var(--space-2)' }}><Skeleton width="80px" height="24px" /></div>
            </div>
            <div style={{ padding: '0 var(--space-6)' }}>
              <Skeleton width="60px" height="12px" />
              <div style={{ marginTop: 'var(--space-2)' }}><Skeleton width="80px" height="24px" /></div>
            </div>
          </div>
        </div>
      </div>

      {/* Grid skeleton */}
      <div class="dashboard-grid">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} class="card" style={{ minHeight: '200px' }}>
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Skeleton width="120px" height="14px" />
            </div>
            <Skeleton width="100%" height="16px" />
            <div style={{ marginTop: 'var(--space-3)' }}><Skeleton width="80%" height="16px" /></div>
            <div style={{ marginTop: 'var(--space-3)' }}><Skeleton width="60%" height="16px" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Dashboard(_props: DashboardProps) {
  const { loading, error } = useStatus();

  // Use real status if available, fall back to mock
  const data = statusSignal.value ?? mockStatus;

  // Show skeleton only on true initial load (no data at all yet)
  if (loading && !statusSignal.value) {
    return <DashboardSkeleton />;
  }

  return (
    <div class="container animate-fade-in">
      {error && !statusSignal.value && (
        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          background: 'var(--color-warning-glow)',
          border: '1px solid var(--color-warning)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--color-warning)',
          fontSize: 'var(--text-sm)',
          marginBottom: 'var(--space-6)',
        }}>
          Using demo data. Backend not reachable: {error}
        </div>
      )}

      {/* Hero */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <StatusHero status={data} />
      </div>

      {/* Dashboard Grid */}
      <div class="dashboard-grid">
        <StorageCard storage={data.storage} />
        <DashcamCard events={data.dashcamEvents} />
        <ArchiveCard archive={data.archive} />
        <NetworkCard />
        <MusicCard music={data.music} />
        <SystemCard system={data.system} />
      </div>
    </div>
  );
}
