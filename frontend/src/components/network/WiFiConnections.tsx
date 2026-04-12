import { useState } from 'preact/hooks';
import { Card } from '../common/Card';
import { Modal } from '../common/Modal';
import { SignalBars } from './NetworkStatusHero';
import type { WiFiConnection } from '../../api/types';
import { addNotification } from '../../stores/appState';

interface WiFiConnectionsProps {
  connections: WiFiConnection[];
  onRemove: (ssid: string) => Promise<void>;
  onUpdatePriority: (ssid: string, priority: number) => Promise<void>;
  onConnect: (ssid: string) => Promise<void>;
  onAddClick: () => void;
}

function WiFiIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12.55a11 11 0 0114.08 0" />
      <path d="M1.42 9a16 16 0 0121.16 0" />
      <path d="M8.53 16.11a6 6 0 016.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="18,15 12,9 6,15" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6,9 12,15 18,9" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3,6 5,6 21,6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function WiFiConnections({ connections, onRemove, onUpdatePriority, onConnect, onAddClick }: WiFiConnectionsProps) {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const sorted = [...connections].sort((a, b) => b.priority - a.priority);

  async function handleDelete() {
    if (!deleteTarget) return;
    setWorking(true);
    try {
      await onRemove(deleteTarget);
      addNotification('success', `Removed ${deleteTarget}`);
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Failed to remove network');
    } finally {
      setWorking(false);
      setDeleteTarget(null);
    }
  }

  async function handlePriorityChange(ssid: string, currentPriority: number, direction: 'up' | 'down') {
    const newPriority = direction === 'up' ? currentPriority + 1 : Math.max(0, currentPriority - 1);
    try {
      await onUpdatePriority(ssid, newPriority);
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Failed to update priority');
    }
  }

  async function handleConnect(ssid: string) {
    try {
      await onConnect(ssid);
      addNotification('success', `Connecting to ${ssid}...`);
    } catch (err) {
      addNotification('error', err instanceof Error ? err.message : 'Failed to connect');
    }
  }

  return (
    <Card
      title="Saved WiFi Networks"
      icon={<WiFiIcon />}
    >
      {sorted.length === 0 ? (
        <div class="empty-state">
          <p class="empty-state__text">No saved WiFi networks</p>
        </div>
      ) : (
        <div class="wifi-list">
          {sorted.map(conn => (
            <div key={conn.uuid} class={`wifi-item ${conn.active ? 'wifi-item--active' : ''}`}>
              <span class={conn.active ? 'wifi-item__active-dot' : 'wifi-item__inactive-dot'} />
              <span class="wifi-item__priority" title={`Priority: ${conn.priority}`}>
                {conn.priority}
              </span>
              <div class="wifi-item__info">
                <div class="wifi-item__ssid">{conn.ssid}</div>
                <div class="wifi-item__meta">
                  {conn.active ? (
                    <span>
                      Active
                      {conn.ipAddress && ` -- ${conn.ipAddress}`}
                    </span>
                  ) : (
                    <span>{conn.autoConnect ? 'Auto-connect' : 'Manual'}</span>
                  )}
                </div>
              </div>
              {conn.active && conn.signal !== null && (
                <span style={{ marginRight: 'var(--space-2)' }}>
                  <SignalBars signal={conn.signal} />
                </span>
              )}
              <div class="wifi-item__actions">
                {!conn.active && (
                  <button
                    class="wifi-item__action-btn"
                    onClick={() => handleConnect(conn.ssid)}
                    title="Connect"
                  >
                    <WiFiIcon />
                  </button>
                )}
                <button
                  class="wifi-item__action-btn"
                  onClick={() => handlePriorityChange(conn.ssid, conn.priority, 'up')}
                  title="Increase priority"
                >
                  <ArrowUpIcon />
                </button>
                <button
                  class="wifi-item__action-btn"
                  onClick={() => handlePriorityChange(conn.ssid, conn.priority, 'down')}
                  title="Decrease priority"
                >
                  <ArrowDownIcon />
                </button>
                <button
                  class="wifi-item__action-btn wifi-item__action-btn--danger"
                  onClick={() => setDeleteTarget(conn.ssid)}
                  title="Remove network"
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 'var(--space-4)' }}>
        <button class="btn btn--ghost" onClick={onAddClick}>
          <PlusIcon />
          Add Network
        </button>
      </div>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Remove WiFi Network"
        confirmLabel={working ? 'Removing...' : 'Remove'}
        danger
      >
        <p>
          Are you sure you want to remove <strong>{deleteTarget}</strong>?
          {connections.find(c => c.ssid === deleteTarget)?.active && (
            <span style={{ display: 'block', marginTop: 'var(--space-2)', color: 'var(--color-warning)' }}>
              This network is currently active. Removing it will disconnect TeslaPi.
            </span>
          )}
        </p>
      </Modal>
    </Card>
  );
}
