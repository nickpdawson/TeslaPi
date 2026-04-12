import { useState, useEffect } from 'preact/hooks';
import { Card } from '../common/Card';
import { get } from '../../api/client';
import type { NetworkStatus, WireGuardStatus } from '../../api/types';

function NetworkIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12.55a11 11 0 0114.08 0" />
      <path d="M1.42 9a16 16 0 0121.16 0" />
      <path d="M8.53 16.11a6 6 0 016.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12,5 19,12 12,19" />
    </svg>
  );
}

function SignalBarsSmall({ signal }: { signal: number | null }) {
  // Signal may be 0-100 (percent) or negative (dBm). Normalize to 0-4 bars.
  let strength = 0;
  if (signal !== null) {
    if (signal >= 0) {
      strength = Math.min(4, Math.max(0, Math.ceil(signal / 25)));
    } else {
      strength = Math.min(4, Math.max(0, Math.ceil((signal + 90) / 15)));
    }
  }
  const cls = strength <= 1 ? 'signal-bars--weak' : strength <= 2 ? 'signal-bars--fair' : 'signal-bars--good';

  return (
    <span class={`signal-bars ${cls}`}>
      {[1, 2, 3, 4].map(i => (
        <span key={i} class={`signal-bar ${i <= strength ? 'signal-bar--filled' : ''}`} />
      ))}
    </span>
  );
}

export function NetworkCard() {
  const [netStatus, setNetStatus] = useState<NetworkStatus | null>(null);
  const [wgStatus, setWgStatus] = useState<WireGuardStatus | null>(null);

  useEffect(() => {
    async function fetchNet() {
      try {
        const raw = await get<Record<string, unknown>>('/network/status');
        // API returns { wifi: {...}, wireguard: {...} }
        const wifi = (raw.wifi ?? raw) as Record<string, unknown>;
        const wg = (raw.wireguard ?? null) as Record<string, unknown> | null;

        setNetStatus({
          connected: Boolean(wifi.connected ?? false),
          ssid: (wifi.ssid ?? null) as string | null,
          signal: wifi.signal != null ? Number(wifi.signal) : null,
          ipAddress: (wifi.ip_address ?? wifi.ipAddress ?? null) as string | null,
          gateway: (wifi.gateway ?? null) as string | null,
          dns: (wifi.dns ?? []) as string[],
          macAddress: (wifi.mac_address ?? wifi.macAddress ?? null) as string | null,
          frequency: (wifi.frequency ?? null) as string | null,
          isHomeNetwork: Boolean(wifi.is_home_network ?? wifi.isHomeNetwork ?? false),
        });

        if (wg) {
          setWgStatus({
            installed: Boolean(wg.installed ?? false),
            configured: Boolean(wg.configured ?? false),
            active: Boolean(wg.active ?? false),
            interface: String(wg.interface ?? 'wg-teslapi'),
            address: (wg.address ?? null) as string | null,
            peerEndpoint: (wg.peer_endpoint ?? wg.peerEndpoint ?? null) as string | null,
            lastHandshake: (wg.last_handshake ?? wg.lastHandshake ?? null) as string | null,
            transferRx: (wg.transfer_rx ?? wg.transferRx ?? null) as number | null,
            transferTx: (wg.transfer_tx ?? wg.transferTx ?? null) as number | null,
            allowedIps: (wg.allowed_ips ?? wg.allowedIps ?? null) as string | null,
            autoConnect: Boolean(wg.auto_connect ?? wg.autoConnect ?? false),
            onlyNonHome: Boolean(wg.only_non_home ?? wg.onlyNonHome ?? true),
            homeSsid: (wg.home_ssid ?? wg.homeSsid ?? null) as string | null,
          });
        }
      } catch {
        // Not critical for dashboard
      }
    }

    fetchNet();
    const timer = setInterval(fetchNet, 15000);
    return () => clearInterval(timer);
  }, []);

  const wgLabel = wgStatus?.configured
    ? (wgStatus.active ? 'Active' : 'Inactive')
    : 'Not configured';

  const wgColor = wgStatus?.active
    ? 'var(--color-success)'
    : 'var(--color-text-muted)';

  return (
    <Card title="Network" icon={<NetworkIcon />}>
      <div>
        <div class="net-card__row">
          <span class="net-card__row-label">WiFi</span>
          <span class="net-card__row-value">
            {netStatus?.ssid ?? 'Disconnected'}
            {netStatus?.signal !== null && netStatus?.signal !== undefined && (
              <span style={{ marginLeft: 'var(--space-2)' }}>
                <SignalBarsSmall signal={netStatus.signal} />
              </span>
            )}
          </span>
        </div>
        <div class="net-card__row">
          <span class="net-card__row-label">IP Address</span>
          <span class="net-card__row-value" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
            {netStatus?.ipAddress ?? '--'}
          </span>
        </div>
        <div class="net-card__row">
          <span class="net-card__row-label">WireGuard</span>
          <span class="net-card__row-value" style={{ color: wgColor }}>
            {wgStatus?.active && (
              <span style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: 'var(--color-success)',
                display: 'inline-block',
                marginRight: 'var(--space-2)',
                boxShadow: '0 0 4px var(--color-success)',
              }} />
            )}
            {wgLabel}
          </span>
        </div>
        <a href="/network" class="net-card__manage-link">
          Manage
          <ArrowRightIcon />
        </a>
      </div>
    </Card>
  );
}
