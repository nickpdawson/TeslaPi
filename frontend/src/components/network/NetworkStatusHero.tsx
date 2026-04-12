import type { NetworkStatus, WireGuardStatus } from '../../api/types';

interface NetworkStatusHeroProps {
  status: NetworkStatus | null;
  wgStatus: WireGuardStatus | null;
}

function SignalBars({ signal, large }: { signal: number | null; large?: boolean }) {
  // signal is in dBm, typically -30 (excellent) to -90 (unusable)
  const strength = signal !== null ? Math.min(4, Math.max(0, Math.ceil((signal + 90) / 15))) : 0;
  const cls = strength <= 1 ? 'signal-bars--weak' : strength <= 2 ? 'signal-bars--fair' : 'signal-bars--good';

  return (
    <span class={`signal-bars ${cls} ${large ? 'signal-bars--lg' : ''}`}>
      {[1, 2, 3, 4].map(i => (
        <span key={i} class={`signal-bar ${i <= strength ? 'signal-bar--filled' : ''}`} />
      ))}
    </span>
  );
}

function WgBadge({ wgStatus }: { wgStatus: WireGuardStatus | null }) {
  if (!wgStatus || !wgStatus.configured) {
    return (
      <span class="net-hero__wg-badge net-hero__wg-badge--unconfigured">
        WireGuard Not Configured
      </span>
    );
  }

  if (wgStatus.active) {
    return (
      <span class="net-hero__wg-badge net-hero__wg-badge--active">
        <span class="net-hero__wg-badge-dot" />
        Tunnel Active
      </span>
    );
  }

  return (
    <span class="net-hero__wg-badge net-hero__wg-badge--inactive">
      <span class="net-hero__wg-badge-dot" />
      Tunnel Down
    </span>
  );
}

function WarningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function NetworkStatusHero({ status, wgStatus }: NetworkStatusHeroProps) {
  const connected = status?.connected ?? false;
  const ssid = status?.ssid ?? null;
  const isHome = status?.isHomeNetwork ?? false;
  const showWarning = connected && !isHome && wgStatus?.configured && !wgStatus?.active;

  let headline = 'Disconnected';
  if (connected && ssid) {
    if (isHome) {
      headline = `Connected to ${ssid}`;
    } else if (wgStatus?.active) {
      headline = `${ssid} + WireGuard`;
    } else {
      headline = `Connected to ${ssid}`;
    }
  }

  return (
    <div class="card card--full">
      <div class="net-hero">
        <div class="net-hero__status-row">
          <span class={`net-hero__dot ${connected ? 'net-hero__dot--connected' : 'net-hero__dot--disconnected'}`} />
          <span class="net-hero__headline">{headline}</span>
          {connected && ssid && (
            <span style={{ marginLeft: 'var(--space-3)' }}>
              <SignalBars signal={status?.signal ?? null} large />
            </span>
          )}
        </div>

        <WgBadge wgStatus={wgStatus} />

        {showWarning && (
          <div class="net-hero__warning">
            <WarningIcon />
            Home resources unreachable -- enable WireGuard tunnel
          </div>
        )}

        <div class="net-hero__stats">
          <div class="net-hero__stat">
            <div class="net-hero__stat-label">IP Address</div>
            <div class="net-hero__stat-value">{status?.ipAddress ?? '--'}</div>
          </div>
          <div class="net-hero__stat">
            <div class="net-hero__stat-label">Gateway</div>
            <div class="net-hero__stat-value">{status?.gateway ?? '--'}</div>
          </div>
          <div class="net-hero__stat">
            <div class="net-hero__stat-label">Frequency</div>
            <div class="net-hero__stat-value">{status?.frequency ?? '--'}</div>
          </div>
          {status?.dns && status.dns.length > 0 && (
            <div class="net-hero__stat">
              <div class="net-hero__stat-label">DNS</div>
              <div class="net-hero__stat-value">{status.dns[0]}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { SignalBars };
