import { useState } from 'preact/hooks';
import { useNetwork } from '../../hooks/useNetwork';
import { Skeleton } from '../common/Skeleton';
import { NetworkStatusHero } from './NetworkStatusHero';
import { WiFiConnections } from './WiFiConnections';
import { WiFiScanner } from './WiFiScanner';
import { AddWiFiModal } from './AddWiFiModal';
import { WireGuardPanel } from './WireGuardPanel';

interface NetworkPageProps {
  path?: string;
}

function NetworkSkeleton() {
  return (
    <div class="container">
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <Skeleton width="200px" height="28px" />
        <div style={{ marginTop: 'var(--space-2)' }}><Skeleton width="340px" height="14px" /></div>
      </div>
      <div class="card card--full" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-8)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Skeleton width="200px" height="20px" />
          <div style={{ marginTop: 'var(--space-4)', display: 'flex', width: '100%', justifyContent: 'center' }}>
            <div style={{ padding: '0 var(--space-6)' }}>
              <Skeleton width="60px" height="12px" />
              <div style={{ marginTop: 'var(--space-2)' }}><Skeleton width="100px" height="18px" /></div>
            </div>
            <div style={{ padding: '0 var(--space-6)' }}>
              <Skeleton width="60px" height="12px" />
              <div style={{ marginTop: 'var(--space-2)' }}><Skeleton width="100px" height="18px" /></div>
            </div>
          </div>
        </div>
      </div>
      {[1, 2, 3].map(i => (
        <div key={i} class="card" style={{ marginBottom: 'var(--space-4)', minHeight: '120px' }}>
          <Skeleton width="180px" height="14px" />
          <div style={{ marginTop: 'var(--space-3)' }}><Skeleton width="100%" height="44px" /></div>
          <div style={{ marginTop: 'var(--space-2)' }}><Skeleton width="100%" height="44px" /></div>
        </div>
      ))}
    </div>
  );
}

export function NetworkPage(_props: NetworkPageProps) {
  const {
    status,
    connections,
    available,
    wgStatus,
    scanning,
    loading,
    error,
    scanNetworks,
    addWifi,
    removeWifi,
    updatePriority,
    connectWifi,
    saveWgConfig,
    toggleWg,
    setWgAuto,
    generateKeys,
    testTunnel,
  } = useNetwork();

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [prefillSsid, setPrefillSsid] = useState('');

  function handleScanSelect(ssid: string) {
    setPrefillSsid(ssid);
    setAddModalOpen(true);
  }

  function handleAddClick() {
    setPrefillSsid('');
    setAddModalOpen(true);
  }

  if (loading) return <NetworkSkeleton />;

  return (
    <div class="container animate-fade-in">
      <div class="network-page-header">
        <h2 class="network-page-title">Network</h2>
        <p class="network-page-subtitle">
          WiFi connections and WireGuard tunnel for home network access
        </p>
      </div>

      {error && (
        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          background: 'var(--color-warning-glow)',
          border: '1px solid var(--color-warning)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--color-warning)',
          fontSize: 'var(--text-sm)',
          marginBottom: 'var(--space-6)',
        }}>
          Network status unavailable: {error}
        </div>
      )}

      <div class="network-sections">
        {/* Network Status Hero */}
        <NetworkStatusHero status={status} wgStatus={wgStatus} />

        {/* Saved WiFi Connections */}
        <WiFiConnections
          connections={connections}
          onRemove={removeWifi}
          onUpdatePriority={updatePriority}
          onConnect={connectWifi}
          onAddClick={handleAddClick}
        />

        {/* Available Networks Scanner */}
        <WiFiScanner
          available={available}
          connections={connections}
          scanning={scanning}
          onScan={scanNetworks}
          onSelect={handleScanSelect}
        />

        {/* WireGuard Tunnel */}
        <WireGuardPanel
          wgStatus={wgStatus}
          connections={connections}
          onSaveConfig={saveWgConfig}
          onToggle={toggleWg}
          onSetAuto={setWgAuto}
          onGenerateKeys={generateKeys}
          onTestTunnel={testTunnel}
        />
      </div>

      {/* Add WiFi Modal */}
      <AddWiFiModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onAdd={addWifi}
        prefillSsid={prefillSsid || undefined}
      />
    </div>
  );
}
