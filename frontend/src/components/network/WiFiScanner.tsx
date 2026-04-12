import { Card } from '../common/Card';
import { SignalBars } from './NetworkStatusHero';
import type { WiFiNetwork, WiFiConnection } from '../../api/types';

interface WiFiScannerProps {
  available: WiFiNetwork[];
  connections: WiFiConnection[];
  scanning: boolean;
  onScan: () => void;
  onSelect: (ssid: string) => void;
}

function ScanIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1.42 9a16 16 0 0121.16 0" />
      <path d="M5 12.55a11 11 0 0114.08 0" />
      <path d="M8.53 16.11a6 6 0 016.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23,4 23,10 17,10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20,6 9,17 4,12" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}

export function WiFiScanner({ available, connections, scanning, onScan, onSelect }: WiFiScannerProps) {
  const savedSsids = new Set(connections.map(c => c.ssid));

  // Filter out empty SSIDs and sort by signal strength
  const networks = available
    .filter(n => n.ssid && n.ssid.length > 0)
    .sort((a, b) => b.signal - a.signal);

  return (
    <Card
      title="Available Networks"
      icon={<ScanIcon />}
    >
      <div class="scan-header">
        <span class="text-xs text-muted">
          {networks.length} network{networks.length !== 1 ? 's' : ''} found
        </span>
        <button
          class={`btn btn--ghost btn--sm ${scanning ? 'animate-spin' : ''}`}
          onClick={onScan}
          disabled={scanning}
          title="Scan for networks"
        >
          <RefreshIcon />
          {scanning ? 'Scanning...' : 'Scan'}
        </button>
      </div>

      {networks.length === 0 ? (
        <div class="empty-state" style={{ padding: 'var(--space-4)' }}>
          <p class="empty-state__text">
            {scanning ? 'Scanning for networks...' : 'No networks found. Try scanning again.'}
          </p>
        </div>
      ) : (
        <div class="scan-list">
          {networks.map(net => {
            const isSaved = savedSsids.has(net.ssid);
            return (
              <div
                key={`${net.ssid}-${net.frequency}`}
                class={`scan-item ${isSaved ? 'scan-item--saved' : ''}`}
                onClick={() => !isSaved && onSelect(net.ssid)}
                role={isSaved ? undefined : 'button'}
                tabIndex={isSaved ? undefined : 0}
              >
                <SignalBars signal={net.signal} />
                <div class="scan-item__info">
                  <div class="scan-item__ssid">
                    {net.ssid}
                    {net.inUse && (
                      <span style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--color-success)',
                        marginLeft: 'var(--space-2)',
                      }}>
                        Connected
                      </span>
                    )}
                  </div>
                  <div class="scan-item__detail">
                    {net.security !== 'open' && (
                      <span style={{ marginRight: 'var(--space-2)', display: 'inline-flex', alignItems: 'center' }}>
                        <LockIcon />
                        <span style={{ marginLeft: '2px' }}>{net.security}</span>
                      </span>
                    )}
                    {net.frequency}
                  </div>
                </div>
                {isSaved && (
                  <span class="scan-item__saved-check" title="Already saved">
                    <CheckIcon />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
