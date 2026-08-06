import { useState } from 'preact/hooks';
import { Card } from '../common/Card';
import { FormField } from '../common/FormField';
import { Toggle } from '../common/Toggle';
import { addNotification } from '../../stores/appState';
import type { WireGuardStatus, WireGuardConfig, WiFiConnection } from '../../api/types';

interface WireGuardPanelProps {
  wgStatus: WireGuardStatus | null;
  connections: WiFiConnection[];
  onSaveConfig: (config: WireGuardConfig) => Promise<void>;
  onToggle: (enable: boolean) => Promise<void>;
  onSetAuto: (enabled: boolean, onlyNonHome: boolean, homeSsid: string | null) => Promise<void>;
  onGenerateKeys: () => Promise<{ publicKey: string }>;
  onTestTunnel: () => Promise<{ success: boolean; message: string }>;
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function WireGuardSetup({ onGenerateKeys, onSaveConfig }: {
  onGenerateKeys: () => Promise<{ publicKey: string }>;
  onSaveConfig: (config: WireGuardConfig) => Promise<void>;
}) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  // Config form
  const [address, setAddress] = useState('');
  const [peerPublicKey, setPeerPublicKey] = useState('');
  const [peerEndpoint, setPeerEndpoint] = useState('');
  const [allowedIps, setAllowedIps] = useState('10.0.0.0/16, 172.16.0.0/16');
  const [dns, setDns] = useState('');
  const [keepalive, setKeepalive] = useState(25);
  const [saving, setSaving] = useState(false);

  async function handleGenerateKeys() {
    setGenerating(true);
    try {
      const result = await onGenerateKeys();
      setPublicKey(result.publicKey);
      addNotification('success', 'Keys generated. Copy the public key to your WireGuard peer.');
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Failed to generate keys');
    } finally {
      setGenerating(false);
    }
  }

  async function handleSave() {
    if (!address || !peerPublicKey || !peerEndpoint || !allowedIps) {
      addNotification('error', 'Please fill in all required fields');
      return;
    }

    setSaving(true);
    try {
      await onSaveConfig({
        privateKey: '', // Server manages the private key
        address,
        dns: dns || null,
        peerPublicKey,
        peerEndpoint,
        allowedIps,
        persistentKeepalive: keepalive,
        // Keys generated in this flow → apply the freshly generated stored key.
        // Otherwise this is an edit and the server keeps the active tunnel key.
        useGeneratedKey: Boolean(publicKey),
      });
      addNotification('success', 'WireGuard configuration saved');
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      addNotification('success', 'Copied to clipboard');
    }).catch(() => {
      addNotification('error', 'Failed to copy. Select the text manually.');
    });
  }

  return (
    <div class="wg-setup">
      <div class="wg-setup__icon">
        <ShieldIcon />
      </div>
      <h3 class="wg-setup__title">Set Up WireGuard Tunnel</h3>
      <p class="wg-setup__desc">
        WireGuard creates a secure tunnel back to your home network when TeslaPi is connected to
        a mobile hotspot or any non-home WiFi. This lets you still archive dashcam footage and
        access home resources while away.
      </p>

      {/* Step 1: Generate Keys */}
      <div class="wg-step">
        <div class="wg-step__header">
          <span class="wg-step__number">1</span>
          <span class="wg-step__title">Generate Keypair</span>
        </div>
        <div class="wg-step__content">
          <p class="text-sm text-muted" style={{ marginBottom: 'var(--space-3)', lineHeight: 'var(--leading-relaxed)' }}>
            Generate a WireGuard keypair for this Pi. The private key stays on the device.
            You will need to add the public key as a peer on your home WireGuard server (e.g., pfSense).
          </p>
          <button class="btn btn--primary" onClick={handleGenerateKeys} disabled={generating}>
            {generating ? 'Generating...' : publicKey ? 'Regenerate Keys' : 'Generate Keys'}
          </button>
          {publicKey && (
            <div class="wg-pubkey-display">
              <span class="wg-pubkey-display__key">{publicKey}</span>
              <button
                class="btn btn--ghost btn--sm"
                onClick={() => copyToClipboard(publicKey)}
                title="Copy public key"
              >
                <CopyIcon />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Step 2: Configuration */}
      <div class="wg-step">
        <div class="wg-step__header">
          <span class="wg-step__number">2</span>
          <span class="wg-step__title">Configure Tunnel</span>
        </div>
        <div class="wg-step__content">
          <FormField
            label="TeslaPi Tunnel Address"
            helpText="The IP address for TeslaPi on the WireGuard tunnel. Must match the AllowedIPs on your server peer config. Example: 192.168.7.3/32"
            htmlFor="wg-address"
          >
            <input
              id="wg-address"
              type="text"
              class="text-input"
              value={address}
              onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
              placeholder="192.168.7.3/32"
            />
          </FormField>

          <FormField
            label="Peer Public Key"
            helpText="The public key of your home WireGuard server (pfSense, router, etc). Find this in your WireGuard server's tunnel settings."
            htmlFor="wg-peer-pubkey"
          >
            <input
              id="wg-peer-pubkey"
              type="text"
              class="text-input"
              value={peerPublicKey}
              onInput={(e) => setPeerPublicKey((e.target as HTMLInputElement).value)}
              placeholder="aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789+ab="
            />
          </FormField>

          <FormField
            label="Peer Endpoint"
            helpText="Your home WireGuard server's public IP and port. This is the WAN IP of your firewall with the WireGuard listen port. Example: 203.0.113.1:51820"
            htmlFor="wg-peer-endpoint"
          >
            <input
              id="wg-peer-endpoint"
              type="text"
              class="text-input"
              value={peerEndpoint}
              onInput={(e) => setPeerEndpoint((e.target as HTMLInputElement).value)}
              placeholder="203.0.113.1:51820"
            />
          </FormField>

          <FormField
            label="Allowed IPs"
            helpText="The home subnets to route through the tunnel, comma-separated. Include all subnets you want to reach from the car. Example: 10.0.0.0/16, 172.16.0.0/16"
            htmlFor="wg-allowed-ips"
          >
            <input
              id="wg-allowed-ips"
              type="text"
              class="text-input"
              value={allowedIps}
              onInput={(e) => setAllowedIps((e.target as HTMLInputElement).value)}
              placeholder="10.0.0.0/16, 172.16.0.0/16"
            />
          </FormField>

          <FormField
            label="DNS Server (optional)"
            helpText="DNS server to use when the tunnel is active. Typically your home DNS server so internal hostnames resolve. Leave blank to use the network's default DNS."
            htmlFor="wg-dns"
          >
            <input
              id="wg-dns"
              type="text"
              class="text-input"
              value={dns}
              onInput={(e) => setDns((e.target as HTMLInputElement).value)}
              placeholder="192.168.1.1"
            />
          </FormField>

          <FormField
            label="Persistent Keepalive (seconds)"
            helpText="Sends a keepalive packet every N seconds to keep the tunnel alive behind NAT. 25 is a good default. Set to 0 to disable."
            htmlFor="wg-keepalive"
          >
            <input
              id="wg-keepalive"
              type="number"
              class="text-input"
              value={keepalive}
              onInput={(e) => setKeepalive(parseInt((e.target as HTMLInputElement).value, 10) || 0)}
              min={0}
              max={300}
              style={{ maxWidth: '120px' }}
            />
          </FormField>

          <div class="settings-actions">
            <button
              class="btn btn--primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save & Test'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WireGuardConfigured({ wgStatus, connections, onToggle, onSetAuto, onTestTunnel, onEditConfig }: {
  wgStatus: WireGuardStatus;
  connections: WiFiConnection[];
  onToggle: (enable: boolean) => Promise<void>;
  onSetAuto: (enabled: boolean, onlyNonHome: boolean, homeSsid: string | null) => Promise<void>;
  onTestTunnel: () => Promise<{ success: boolean; message: string }>;
  onEditConfig: () => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  async function handleToggle(enable: boolean) {
    setToggling(true);
    try {
      await onToggle(enable);
      addNotification('success', enable ? 'WireGuard tunnel enabled' : 'WireGuard tunnel disabled');
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Failed to toggle tunnel');
    } finally {
      setToggling(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onTestTunnel();
      setTestResult(result);
      addNotification(result.success ? 'success' : 'error', result.message);
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  }

  async function handleAutoChange(enabled: boolean, onlyNonHome: boolean, homeSsid: string | null) {
    try {
      await onSetAuto(enabled, onlyNonHome, homeSsid);
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Failed to update auto-connect');
    }
  }

  return (
    <div class="wg-panel">
      {/* Status Card */}
      <div class={`wg-status-card ${wgStatus.active ? 'wg-status-card--active' : 'wg-status-card--inactive'}`}>
        <div class="wg-status-header">
          <div class="wg-status-indicator">
            <span class={`wg-status-indicator__dot ${wgStatus.active ? 'wg-status-indicator__dot--active' : 'wg-status-indicator__dot--inactive'}`} />
            <span class="wg-status-indicator__label">
              {wgStatus.active ? 'Tunnel Active' : 'Tunnel Down'}
            </span>
          </div>
          <Toggle
            checked={wgStatus.active}
            onChange={(v) => handleToggle(v)}
            disabled={toggling}
          />
        </div>

        <div class="wg-stats-grid">
          <div class="wg-stat">
            <div class="wg-stat__label">Endpoint</div>
            <div class="wg-stat__value">{wgStatus.peerEndpoint ?? '--'}</div>
          </div>
          <div class="wg-stat">
            <div class="wg-stat__label">Last Handshake</div>
            <div class="wg-stat__value">{formatRelativeTime(wgStatus.lastHandshake)}</div>
          </div>
          <div class="wg-stat">
            <div class="wg-stat__label">Received</div>
            <div class="wg-stat__value">{formatBytes(wgStatus.transferRx)}</div>
          </div>
          <div class="wg-stat">
            <div class="wg-stat__label">Sent</div>
            <div class="wg-stat__value">{formatBytes(wgStatus.transferTx)}</div>
          </div>
        </div>

        {wgStatus.address && (
          <div style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            Interface: {wgStatus.interface} / {wgStatus.address}
            {wgStatus.allowedIps && ` / Allowed: ${wgStatus.allowedIps}`}
          </div>
        )}
      </div>

      {/* Auto-connect Settings */}
      <div class="wg-auto-settings">
        <h4 class="wg-auto-settings__title">Auto-Connect Settings</h4>

        <div style={{ marginBottom: 'var(--space-3)' }}>
          <Toggle
            checked={wgStatus.autoConnect}
            onChange={(v) => handleAutoChange(v, wgStatus.onlyNonHome, wgStatus.homeSsid)}
            label="Auto-connect when away from home"
          />
        </div>

        {wgStatus.autoConnect && (
          <div>
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <Toggle
                checked={wgStatus.onlyNonHome}
                onChange={(v) => handleAutoChange(wgStatus.autoConnect, v, wgStatus.homeSsid)}
                label="Only when not on home WiFi"
              />
            </div>

            {wgStatus.onlyNonHome && (
              <FormField
                label="Home WiFi Network"
                helpText="Which saved network is your home WiFi? When connected to this network, the tunnel will stay down. On any other network, it will come up automatically."
                htmlFor="wg-home-ssid"
              >
                <div class="select-container">
                  <select
                    id="wg-home-ssid"
                    class="select-input"
                    value={wgStatus.homeSsid ?? ''}
                    onChange={(e) => handleAutoChange(
                      wgStatus.autoConnect,
                      wgStatus.onlyNonHome,
                      (e.target as HTMLSelectElement).value || null,
                    )}
                  >
                    <option value="">-- Select home network --</option>
                    {connections.map(c => (
                      <option key={c.uuid} value={c.ssid}>{c.ssid}</option>
                    ))}
                  </select>
                  <span class="select-chevron">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="4,6 8,10 12,6" />
                    </svg>
                  </span>
                </div>
              </FormField>
            )}

            <p class="wg-auto-settings__help">
              When connected to any network other than your home WiFi, TeslaPi will automatically
              establish the WireGuard tunnel to reach your home network. This means dashcam archiving,
              Home Assistant updates, and other home-dependent features keep working from anywhere.
            </p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div class="wg-actions">
        <button class="btn btn--primary" onClick={handleTest} disabled={testing}>
          {testing ? 'Testing...' : 'Test Tunnel'}
        </button>
        <button class="btn btn--ghost" onClick={onEditConfig}>
          Edit Config
        </button>
      </div>

      {testResult && (
        <div class={`test-result tunnel-test ${testResult.success ? 'test-result--success' : 'test-result--error'}`}>
          <span class="test-result__icon">{testResult.success ? 'OK' : '!!'}</span>
          {testResult.message}
        </div>
      )}
    </div>
  );
}

export function WireGuardPanel({ wgStatus, connections, onSaveConfig, onToggle, onSetAuto, onGenerateKeys, onTestTunnel }: WireGuardPanelProps) {
  const [editing, setEditing] = useState(false);

  const isConfigured = wgStatus?.configured ?? false;

  return (
    <Card
      title="WireGuard Tunnel"
      icon={<ShieldIcon />}
    >
      {!isConfigured || editing ? (
        <WireGuardSetup
          onGenerateKeys={onGenerateKeys}
          onSaveConfig={async (config) => {
            await onSaveConfig(config);
            setEditing(false);
          }}
        />
      ) : wgStatus ? (
        <WireGuardConfigured
          wgStatus={wgStatus}
          connections={connections}
          onToggle={onToggle}
          onSetAuto={onSetAuto}
          onTestTunnel={onTestTunnel}
          onEditConfig={() => setEditing(true)}
        />
      ) : null}
    </Card>
  );
}
