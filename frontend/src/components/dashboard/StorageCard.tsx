import { Card } from '../common/Card';
import { ProgressBar } from '../common/ProgressBar';
import type { StorageInfo } from '../../api/types';

interface StorageCardProps {
  storage: StorageInfo[];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function DriveIcon({ drive }: { drive: string }) {
  if (drive === 'external') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function StorageIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

export function StorageCard({ storage }: StorageCardProps) {
  const expandContent = (
    <div>
      {storage.map(s => (
        <div key={s.drive} style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: 'var(--space-2) 0',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-text-muted)',
          borderBottom: '1px solid var(--color-border)',
        }}>
          <span>{s.label}</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {s.filesystem.toUpperCase()} &middot; {s.mountpoint}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <Card
      title="Storage"
      icon={<StorageIcon />}
      expandable
      expandContent={expandContent}
      className="card--wide"
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {storage.length === 0 && (
          <div style={{
            padding: 'var(--space-4) 0',
            textAlign: 'center',
            color: 'var(--color-text-muted)',
            fontSize: 'var(--text-sm)',
          }}>
            No drives configured yet. Complete the setup wizard or connect an external drive to get started.
          </div>
        )}
        {storage.map(s => (
          <div key={s.drive} style={{ marginBottom: 'var(--space-4)' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: 'var(--space-2)',
            }}>
              <span style={{ marginRight: 'var(--space-2)', color: 'var(--color-text-secondary)' }}>
                <DriveIcon drive={s.drive} />
              </span>
              <span style={{
                fontSize: 'var(--text-sm)',
                fontWeight: 'var(--font-weight-medium)',
                flex: 1,
              }}>
                {s.label}
              </span>
              <span style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text-muted)',
                fontFamily: 'var(--font-mono)',
              }}>
                {formatBytes(s.usedBytes)} / {formatBytes(s.totalBytes)}
              </span>
            </div>
            <ProgressBar value={s.usedBytes / s.totalBytes} size="sm" />
          </div>
        ))}
      </div>
    </Card>
  );
}
