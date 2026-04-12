import { useState, useEffect } from 'preact/hooks';
import { Card } from '../common/Card';
import { GeneralSettings } from './GeneralSettings';
import { ShareSettings } from './ShareSettings';
import { DriveSettings } from './DriveSettings';
import { NotifySettings } from './NotifySettings';
import { HASettings } from './HASettings';
import { SystemSettings } from './SystemSettings';
import { get, put } from '../../api/client';
import { addNotification } from '../../stores/appState';
import type { TeslaPiConfig } from '../../api/types';
import { Skeleton } from '../common/Skeleton';

interface SettingsProps {
  path?: string;
}

const DEFAULT_CONFIG: TeslaPiConfig = {
  hostname: 'teslapi',
  timezone: 'America/Denver',
  wifi: { ssid: '', country: 'US' },
  archive: { system: 'cifs' },
  drives: [
    { name: 'cam', size: '140G', enabled: true, filesystem: 'exfat' },
    { name: 'music', size: '1800G', enabled: true, filesystem: 'exfat' },
    { name: 'lightshow', size: '1G', enabled: true, filesystem: 'exfat' },
    { name: 'boombox', size: '100M', enabled: true, filesystem: 'exfat' },
  ],
  dataDrive: '/dev/sda',
  notifications: [],
};

function SettingsSkeleton() {
  return (
    <div class="container">
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <Skeleton width="200px" height="28px" />
        <div style={{ marginTop: 'var(--space-2)' }}><Skeleton width="300px" height="14px" /></div>
      </div>
      {[1, 2, 3, 4].map(i => (
        <div key={i} class="card" style={{ marginBottom: 'var(--space-4)', minHeight: '80px' }}>
          <Skeleton width="180px" height="14px" />
          <div style={{ marginTop: 'var(--space-3)' }}><Skeleton width="100%" height="16px" /></div>
        </div>
      ))}
    </div>
  );
}

export function Settings(_props: SettingsProps) {
  const [config, setConfig] = useState<TeslaPiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const response = await get<{ config: Record<string, string> }>('/config');
      const raw = response.config;
      // Map the flat key-value config to our structured format
      const parsed = parseConfig(raw);
      setConfig(parsed);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load configuration');
      // Use defaults so the UI is still usable
      setConfig(DEFAULT_CONFIG);
    } finally {
      setLoading(false);
    }
  }

  function parseConfig(raw: Record<string, string>): TeslaPiConfig {
    return {
      hostname: raw['TESLAPI_HOSTNAME'] ?? raw['hostname'] ?? DEFAULT_CONFIG.hostname,
      timezone: raw['timezone'] ?? raw['TIMEZONE'] ?? DEFAULT_CONFIG.timezone,
      wifi: {
        ssid: raw['SSID'] ?? raw['ssid'] ?? '',
        password: raw['WIFIPASS'] ?? raw['wifi_password'],
        country: raw['WIFI_COUNTRY'] ?? raw['wifi_country'] ?? 'US',
      },
      archive: {
        system: (raw['ARCHIVE_SYSTEM'] ?? raw['archive_system'] ?? 'cifs') as TeslaPiConfig['archive']['system'],
        share: {
          type: (raw['SHARE_TYPE'] ?? raw['share_type'] ?? 'cifs') as 'cifs' | 'nfs',
          server: raw['ARCHIVE_SERVER'] ?? raw['archive_server'] ?? '',
          path: raw['SHARE_NAME'] ?? raw['share_name'] ?? '',
          username: raw['SHARE_USER'] ?? raw['share_user'],
          password: raw['SHARE_PASSWORD'] ?? raw['share_password'],
          domain: raw['SHARE_DOMAIN'] ?? raw['share_domain'],
          mountOptions: raw['SHARE_MOUNT_OPTIONS'] ?? raw['share_mount_options'],
        },
      },
      musicShare: raw['MUSIC_SERVER'] ? {
        type: (raw['MUSIC_SHARE_TYPE'] ?? 'cifs') as 'cifs' | 'nfs',
        server: raw['MUSIC_SERVER'] ?? '',
        path: raw['MUSIC_SHARE_NAME'] ?? '',
        username: raw['MUSIC_USER'],
        password: raw['MUSIC_PASSWORD'],
      } : undefined,
      drives: [
        { name: 'cam', size: raw['CAM_SIZE'] ?? '140G', enabled: raw['CAM_ENABLED'] !== 'false', filesystem: (raw['CAM_FS'] ?? 'exfat') as 'ext4' | 'exfat' },
        { name: 'music', size: raw['MUSIC_SIZE'] ?? '1800G', enabled: raw['MUSIC_ENABLED'] !== 'false', filesystem: (raw['MUSIC_FS'] ?? 'exfat') as 'ext4' | 'exfat' },
        { name: 'lightshow', size: raw['LIGHTSHOW_SIZE'] ?? '1G', enabled: raw['LIGHTSHOW_ENABLED'] !== 'false', filesystem: (raw['LIGHTSHOW_FS'] ?? 'exfat') as 'ext4' | 'exfat' },
        { name: 'boombox', size: raw['BOOMBOX_SIZE'] ?? '100M', enabled: raw['BOOMBOX_ENABLED'] !== 'false', filesystem: (raw['BOOMBOX_FS'] ?? 'exfat') as 'ext4' | 'exfat' },
      ],
      dataDrive: raw['DATA_DRIVE'] ?? raw['data_drive'] ?? '/dev/sda',
      ha: raw['HA_URL'] ? {
        enabled: raw['HA_ENABLED'] === 'true',
        url: raw['HA_URL'] ?? '',
        token: raw['HA_TOKEN'] ?? '',
        mqttBroker: raw['MQTT_BROKER'],
        mqttPort: raw['MQTT_PORT'] ? parseInt(raw['MQTT_PORT'], 10) : undefined,
        mqttUsername: raw['MQTT_USER'],
        mqttPassword: raw['MQTT_PASSWORD'],
      } : undefined,
      notifications: parseNotificationChannels(raw),
    };
  }

  function parseNotificationChannels(raw: Record<string, string>): TeslaPiConfig['notifications'] {
    const channels: TeslaPiConfig['notifications'] = [];
    // Look for NOTIFY_*_TYPE keys
    for (const key of Object.keys(raw)) {
      const match = key.match(/^NOTIFY_(\w+)_TYPE$/);
      if (match) {
        const id = match[1].toLowerCase();
        const prefix = `NOTIFY_${match[1]}`;
        const channelConfig: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (k.startsWith(prefix + '_') && k !== key && k !== `${prefix}_ENABLED`) {
            const fieldName = k.slice(prefix.length + 1).toLowerCase();
            channelConfig[fieldName] = v;
          }
        }
        channels.push({
          id,
          type: raw[key] as any,
          enabled: raw[`${prefix}_ENABLED`] !== 'false',
          config: channelConfig,
        });
      }
    }
    return channels;
  }

  async function saveSection(updates: Record<string, string>) {
    try {
      await put('/config', { updates });
      addNotification('success', 'Settings saved successfully');
      await loadConfig(); // Reload to get server-validated values
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save settings';
      addNotification('error', msg);
      throw err;
    }
  }

  async function handleGeneralSave(data: { hostname: string; timezone: string; wifi: { ssid: string; password?: string; country: string } }) {
    await saveSection({
      TESLAPI_HOSTNAME: data.hostname,
      TIMEZONE: data.timezone,
      SSID: data.wifi.ssid,
      WIFIPASS: data.wifi.password ?? '',
      WIFI_COUNTRY: data.wifi.country,
    });
  }

  async function handleShareSave(data: { archiveShare?: any; musicShare?: any }) {
    const updates: Record<string, string> = {};
    if (data.archiveShare) {
      updates['SHARE_TYPE'] = data.archiveShare.type;
      updates['ARCHIVE_SERVER'] = data.archiveShare.server;
      updates['SHARE_NAME'] = data.archiveShare.path;
      if (data.archiveShare.username) updates['SHARE_USER'] = data.archiveShare.username;
      if (data.archiveShare.password) updates['SHARE_PASSWORD'] = data.archiveShare.password;
      if (data.archiveShare.domain) updates['SHARE_DOMAIN'] = data.archiveShare.domain;
      if (data.archiveShare.mountOptions) updates['SHARE_MOUNT_OPTIONS'] = data.archiveShare.mountOptions;
    }
    if (data.musicShare) {
      updates['MUSIC_SHARE_TYPE'] = data.musicShare.type;
      updates['MUSIC_SERVER'] = data.musicShare.server;
      updates['MUSIC_SHARE_NAME'] = data.musicShare.path;
      if (data.musicShare.username) updates['MUSIC_USER'] = data.musicShare.username;
      if (data.musicShare.password) updates['MUSIC_PASSWORD'] = data.musicShare.password;
    }
    await saveSection(updates);
  }

  async function handleDriveSave(data: { drives: any[]; dataDrive: string }) {
    const updates: Record<string, string> = { DATA_DRIVE: data.dataDrive };
    for (const drive of data.drives) {
      const prefix = drive.name.toUpperCase();
      updates[`${prefix}_SIZE`] = drive.size;
      updates[`${prefix}_ENABLED`] = drive.enabled ? 'true' : 'false';
      updates[`${prefix}_FS`] = drive.filesystem;
    }
    await saveSection(updates);
  }

  async function handleNotifySave(channels: TeslaPiConfig['notifications']) {
    const updates: Record<string, string> = {};
    channels.forEach((ch, idx) => {
      const prefix = `NOTIFY_${idx}`;
      updates[`${prefix}_TYPE`] = ch.type;
      updates[`${prefix}_ENABLED`] = ch.enabled ? 'true' : 'false';
      for (const [k, v] of Object.entries(ch.config)) {
        updates[`${prefix}_${k.toUpperCase()}`] = v;
      }
    });
    await saveSection(updates);
  }

  async function handleHASave(haConfig: TeslaPiConfig['ha'] & {}) {
    const updates: Record<string, string> = {
      HA_ENABLED: haConfig.enabled ? 'true' : 'false',
      HA_URL: haConfig.url,
      HA_TOKEN: haConfig.token,
    };
    if (haConfig.mqttBroker) updates['MQTT_BROKER'] = haConfig.mqttBroker;
    if (haConfig.mqttPort) updates['MQTT_PORT'] = String(haConfig.mqttPort);
    if (haConfig.mqttUsername) updates['MQTT_USER'] = haConfig.mqttUsername;
    if (haConfig.mqttPassword) updates['MQTT_PASSWORD'] = haConfig.mqttPassword;
    await saveSection(updates);
  }

  if (loading) return <SettingsSkeleton />;

  const cfg = config ?? DEFAULT_CONFIG;

  return (
    <div class="container animate-fade-in">
      <div class="settings-page-header">
        <h2 class="settings-page-title">Settings</h2>
        <p class="settings-page-subtitle">Configure your TeslaPi installation</p>
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
          Could not load saved config: {error}. Showing defaults.
        </div>
      )}

      <div class="settings-cards">
        <Card
          title="General"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          }
          expandable
          expandContent={
            <GeneralSettings
              hostname={cfg.hostname}
              timezone={cfg.timezone}
              wifi={cfg.wifi}
              onSave={handleGeneralSave}
            />
          }
        >
          <p class="text-sm text-secondary">
            Hostname, timezone, and WiFi configuration
          </p>
        </Card>

        <Card
          title="Network Shares"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          }
          expandable
          expandContent={
            <ShareSettings
              archiveShare={cfg.archive.share}
              musicShare={cfg.musicShare}
              onSave={handleShareSave}
            />
          }
        >
          <p class="text-sm text-secondary">
            Archive and music share connections (CIFS/NFS)
          </p>
        </Card>

        <Card
          title="Drives"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
          }
          expandable
          expandContent={
            <DriveSettings
              drives={cfg.drives}
              dataDrive={cfg.dataDrive}
              onSave={handleDriveSave}
            />
          }
        >
          <p class="text-sm text-secondary">
            Virtual USB drive sizes, filesystems, and data drive selection
          </p>
        </Card>

        <Card
          title="Notifications"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
          }
          expandable
          expandContent={
            <NotifySettings
              channels={cfg.notifications}
              onSave={handleNotifySave}
            />
          }
        >
          <p class="text-sm text-secondary">
            Email, Telegram, Discord, Pushover, and other alert channels
          </p>
        </Card>

        <Card
          title="Home Assistant"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              <polyline points="9,22 9,12 15,12 15,22" />
            </svg>
          }
          expandable
          expandContent={
            <HASettings
              config={cfg.ha ?? { enabled: false, url: '', token: '' }}
              onSave={handleHASave}
            />
          }
        >
          <p class="text-sm text-secondary">
            Home Assistant integration, MQTT, and entity registration
          </p>
        </Card>

        <Card
          title="System"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
              <rect x="9" y="9" width="6" height="6" />
              <line x1="9" y1="1" x2="9" y2="4" />
              <line x1="15" y1="1" x2="15" y2="4" />
              <line x1="9" y1="20" x2="9" y2="23" />
              <line x1="15" y1="20" x2="15" y2="23" />
              <line x1="20" y1="9" x2="23" y2="9" />
              <line x1="20" y1="14" x2="23" y2="14" />
              <line x1="1" y1="9" x2="4" y2="9" />
              <line x1="1" y1="14" x2="4" y2="14" />
            </svg>
          }
          expandable
          expandContent={<SystemSettings />}
        >
          <p class="text-sm text-secondary">
            Reboot, logs, updates, and diagnostics export
          </p>
        </Card>
      </div>
    </div>
  );
}
