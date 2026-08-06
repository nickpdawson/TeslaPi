import { useState } from 'preact/hooks';
import { FormField } from '../common/FormField';
import { Toggle } from '../common/Toggle';
import { Select } from '../common/Select';
import { post } from '../../api/client';
import type { NotificationChannelConfig } from '../../api/types';

interface NotifySettingsProps {
  channels: NotificationChannelConfig[];
  onSave: (channels: NotificationChannelConfig[]) => Promise<void>;
}

const CHANNEL_TYPES = [
  { value: 'email', label: 'Email (SMTP)' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord Webhook' },
  { value: 'slack', label: 'Slack Webhook' },
  { value: 'matrix', label: 'Matrix' },
  { value: 'ha', label: 'Home Assistant' },
  { value: 'pushover', label: 'Pushover' },
  { value: 'gotify', label: 'Gotify' },
];

const CHANNEL_FIELDS: Record<string, { key: string; label: string; helpText: string; type?: string }[]> = {
  email: [
    { key: 'smtp_server', label: 'SMTP Server', helpText: 'Mail server hostname (e.g., smtp.gmail.com)' },
    { key: 'smtp_port', label: 'SMTP Port', helpText: 'Usually 587 for TLS or 465 for SSL', type: 'number' },
    { key: 'smtp_user', label: 'SMTP Username', helpText: 'Email login username' },
    { key: 'smtp_password', label: 'SMTP Password', helpText: 'Email login password or app-specific password', type: 'password' },
    { key: 'from_address', label: 'From Address', helpText: 'Sender email address' },
    { key: 'to_address', label: 'To Address', helpText: 'Recipient email address for notifications' },
  ],
  telegram: [
    { key: 'bot_token', label: 'Bot Token', helpText: 'Token from @BotFather (e.g., 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11)', type: 'password' },
    { key: 'chat_id', label: 'Chat ID', helpText: 'Your Telegram chat or group ID. Use @userinfobot to find yours.' },
  ],
  discord: [
    { key: 'webhook_url', label: 'Webhook URL', helpText: 'Discord channel webhook URL. Create one in Channel Settings > Integrations > Webhooks.', type: 'password' },
  ],
  slack: [
    { key: 'webhook_url', label: 'Webhook URL', helpText: 'Slack incoming webhook URL. Create one at api.slack.com/apps.', type: 'password' },
    { key: 'channel', label: 'Channel', helpText: 'Override channel (optional, e.g., #teslapi)' },
  ],
  matrix: [
    { key: 'homeserver', label: 'Homeserver URL', helpText: 'Matrix homeserver URL (e.g., https://matrix.org)' },
    { key: 'access_token', label: 'Access Token', helpText: 'Bot user access token', type: 'password' },
    { key: 'room_id', label: 'Room ID', helpText: 'Target room ID (e.g., !abc123:matrix.org)' },
  ],
  ha: [
    { key: 'entity_id', label: 'Notification Entity', helpText: 'Home Assistant notify entity (e.g., notify.mobile_app_iphone). Requires HA integration to be configured first.' },
  ],
  pushover: [
    { key: 'user_key', label: 'User Key', helpText: 'Your Pushover user key from pushover.net dashboard', type: 'password' },
    { key: 'api_token', label: 'API Token', helpText: 'Application API token from pushover.net', type: 'password' },
  ],
  gotify: [
    { key: 'server_url', label: 'Server URL', helpText: 'Gotify server URL (e.g., https://gotify.example.com)' },
    { key: 'app_token', label: 'Application Token', helpText: 'Gotify application token', type: 'password' },
  ],
};

const EVENT_TYPES = [
  { key: 'archive_complete', label: 'Archive Complete' },
  { key: 'archive_error', label: 'Archive Error' },
  { key: 'sentry_event', label: 'Sentry Event Detected' },
  { key: 'drive_full', label: 'Drive Full Warning' },
  { key: 'wifi_connected', label: 'WiFi Connected' },
  { key: 'wifi_disconnected', label: 'WiFi Disconnected' },
  { key: 'system_error', label: 'System Error' },
];

function ChannelCard({ channel, onChange, onRemove }: {
  channel: NotificationChannelConfig;
  onChange: (updated: NotificationChannelConfig) => void;
  onRemove: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const fields = CHANNEL_FIELDS[channel.type] ?? [];

  function updateConfig(key: string, value: string) {
    onChange({ ...channel, config: { ...channel.config, [key]: value } });
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await post<{ ok: boolean; message: string }>('/notifications/test', {
        type: channel.type,
        config: channel.config,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  }

  const typeLabel = CHANNEL_TYPES.find(t => t.value === channel.type)?.label ?? channel.type;

  return (
    <div class="notify-channel-card">
      <div class="notify-channel-card__header">
        <div style={{ flex: 1 }}>
          <span class="notify-channel-card__type">{typeLabel}</span>
        </div>
        <Toggle
          checked={channel.enabled}
          onChange={(v) => onChange({ ...channel, enabled: v })}
        />
      </div>

      {channel.enabled && (
        <div class="notify-channel-card__body">
          {fields.map(field => (
            <FormField
              key={field.key}
              label={field.label}
              helpText={field.helpText}
              htmlFor={`${channel.id}-${field.key}`}
            >
              <input
                id={`${channel.id}-${field.key}`}
                type={field.type ?? 'text'}
                class="text-input"
                value={channel.config[field.key] ?? ''}
                onInput={(e) => updateConfig(field.key, (e.target as HTMLInputElement).value)}
              />
            </FormField>
          ))}

          <div style={{ display: 'flex', marginTop: 'var(--space-3)' }}>
            <button
              class="btn btn--ghost btn--sm"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? 'Sending...' : 'Send Test'}
            </button>
            <button
              class="btn btn--ghost btn--sm"
              style={{ color: 'var(--color-error)', marginLeft: 'var(--space-2)' }}
              onClick={onRemove}
            >
              Remove
            </button>
          </div>

          {testResult && (
            <div class={`test-result ${testResult.ok ? 'test-result--success' : 'test-result--error'}`}>
              <span class="test-result__icon">{testResult.ok ? '\u2713' : '\u2717'}</span>
              <span>{testResult.message}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function NotifySettings({ channels: initChannels, onSave }: NotifySettingsProps) {
  const [channels, setChannels] = useState<NotificationChannelConfig[]>(initChannels);
  const [newType, setNewType] = useState('email');
  const [saving, setSaving] = useState(false);

  function addChannel() {
    const id = `${newType}-${Date.now()}`;
    setChannels([...channels, {
      id,
      type: newType as NotificationChannelConfig['type'],
      enabled: true,
      config: {},
    }]);
  }

  function updateChannel(index: number, updated: NotificationChannelConfig) {
    const next = [...channels];
    next[index] = updated;
    setChannels(next);
  }

  function removeChannel(index: number) {
    setChannels(channels.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(channels);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="settings-section">
      <p class="settings-description">
        Configure notification channels to receive alerts about archive status, sentry events, drive health, and system errors.
        You can add multiple channels and control which events trigger each one.
      </p>

      {channels.map((channel, idx) => (
        <ChannelCard
          key={channel.id}
          channel={channel}
          onChange={(updated) => updateChannel(idx, updated)}
          onRemove={() => removeChannel(idx)}
        />
      ))}

      <div class="settings-add-row">
        <Select
          options={CHANNEL_TYPES}
          value={newType}
          onChange={setNewType}
        />
        <button class="btn btn--ghost" onClick={addChannel}>
          + Add Channel
        </button>
      </div>

      {channels.length > 0 && (
        <>
          <div class="settings-divider" />
          <h4 class="settings-subsection-title">Event Routing</h4>
          <p class="settings-description">
            Choose which events trigger notifications on each channel.
          </p>
          <div class="event-matrix">
            <table class="event-matrix__table">
              <thead>
                <tr>
                  <th>Event</th>
                  {channels.filter(c => c.enabled).map(ch => (
                    <th key={ch.id}>
                      {CHANNEL_TYPES.find(t => t.value === ch.type)?.label ?? ch.type}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {EVENT_TYPES.map(evt => (
                  <tr key={evt.key}>
                    <td>{evt.label}</td>
                    {channels.filter(c => c.enabled).map(ch => (
                      <td key={ch.id} style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={ch.config[`event_${evt.key}`] === 'true'}
                          onChange={(e) => {
                            const idx = channels.indexOf(ch);
                            updateChannel(idx, {
                              ...ch,
                              config: {
                                ...ch.config,
                                [`event_${evt.key}`]: (e.target as HTMLInputElement).checked ? 'true' : 'false',
                              },
                            });
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div class="settings-actions">
        <button class="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Notification Settings'}
        </button>
      </div>
    </div>
  );
}
