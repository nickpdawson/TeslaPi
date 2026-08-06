import { useState } from 'preact/hooks';
import { FormField } from '../common/FormField';
import { Toggle } from '../common/Toggle';
import { post } from '../../api/client';
import type { HAConfig } from '../../api/types';

interface HASettingsProps {
  config: HAConfig;
  onSave: (config: HAConfig) => Promise<void>;
}

const HA_ENTITIES = [
  { id: 'sensor.teslapi_cpu_temp', name: 'CPU Temperature', description: 'Current CPU temperature in Celsius' },
  { id: 'sensor.teslapi_storage_cam', name: 'Cam Storage Used', description: 'Dashcam drive usage percentage' },
  { id: 'sensor.teslapi_storage_music', name: 'Music Storage Used', description: 'Music drive usage percentage' },
  { id: 'sensor.teslapi_archive_status', name: 'Archive Status', description: 'Current archive state (idle, archiving, error)' },
  { id: 'sensor.teslapi_last_archive', name: 'Last Archive', description: 'Timestamp of the last successful archive' },
  { id: 'sensor.teslapi_wifi_signal', name: 'WiFi Signal', description: 'WiFi signal strength in dBm' },
  { id: 'binary_sensor.teslapi_gadget', name: 'USB Gadget Active', description: 'Whether the USB gadget is connected to the car' },
  { id: 'sensor.teslapi_sentry_events', name: 'Sentry Events Today', description: 'Number of sentry events recorded today' },
  { id: 'button.teslapi_archive_now', name: 'Archive Now', description: 'Trigger an immediate archive cycle' },
  { id: 'button.teslapi_reboot', name: 'Reboot TeslaPi', description: 'Reboot the Raspberry Pi' },
];

export function HASettings({ config: initConfig, onSave }: HASettingsProps) {
  const [config, setConfig] = useState<HAConfig>(initConfig);
  const [showMqtt, setShowMqtt] = useState(!!initConfig.mqttBroker);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; haVersion?: string; instanceName?: string } | null>(null);

  function update<K extends keyof HAConfig>(field: K, value: HAConfig[K]) {
    setConfig({ ...config, [field]: value });
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await post<{ ok: boolean; message: string; haVersion?: string; instanceName?: string }>(
        '/ha/test',
        { url: config.url, token: config.token }
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(config);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="settings-section">
      <p class="settings-description">
        Integrate TeslaPi with Home Assistant to expose sensors, trigger automations, and receive notifications
        through the HA mobile app. Requires a Long-Lived Access Token generated from your HA profile page.
      </p>

      <Toggle
        checked={config.enabled}
        onChange={(v) => update('enabled', v)}
        label="Enable Home Assistant Integration"
      />

      {config.enabled && (
        <>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <FormField
              label="Home Assistant URL"
              helpText="Full URL to your Home Assistant instance, including port if non-standard (e.g., http://homeassistant.local:8123 or https://ha.example.com)."
              htmlFor="ha-url"
            >
              <input
                id="ha-url"
                type="url"
                class="text-input"
                value={config.url}
                onInput={(e) => update('url', (e.target as HTMLInputElement).value)}
                placeholder="http://homeassistant.local:8123"
              />
            </FormField>

            <FormField
              label="Long-Lived Access Token"
              helpText="Generate at: HA Profile > Security > Long-Lived Access Tokens > Create Token. This token does not expire but can be revoked from the same page."
              htmlFor="ha-token"
            >
              <div class="input-with-action">
                <input
                  id="ha-token"
                  type={showToken ? 'text' : 'password'}
                  class="text-input"
                  value={config.token}
                  onInput={(e) => update('token', (e.target as HTMLInputElement).value)}
                  placeholder="eyJhbGciOiJI..."
                />
                <button
                  type="button"
                  class="btn btn--ghost btn--sm input-action-btn"
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? 'Hide' : 'Show'}
                </button>
              </div>
            </FormField>

            <div class="settings-actions" style={{ marginTop: 'var(--space-3)' }}>
              <button
                class="btn btn--ghost"
                onClick={handleTest}
                disabled={testing || !config.url || !config.token}
              >
                {testing && <span class="animate-spin" style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid var(--color-text-muted)', borderTopColor: 'var(--color-accent)', borderRadius: '50%', marginRight: 'var(--space-2)' }} />}
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
            </div>

            {testResult && (
              <div class={`test-result ${testResult.ok ? 'test-result--success' : 'test-result--error'}`}>
                <span class="test-result__icon">{testResult.ok ? '\u2713' : '\u2717'}</span>
                <div>
                  <span>{testResult.message}</span>
                  {testResult.ok && testResult.haVersion && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-1)' }}>
                      HA Version: {testResult.haVersion}
                      {testResult.instanceName && ` | Instance: ${testResult.instanceName}`}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div class="settings-divider" />

          <div class="settings-advanced-toggle">
            <button
              type="button"
              class="btn btn--ghost btn--sm"
              onClick={() => setShowMqtt(!showMqtt)}
            >
              {showMqtt ? 'Hide MQTT Settings' : 'Show MQTT Settings (Advanced)'}
            </button>
          </div>

          {showMqtt && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <p class="settings-description">
                Optional MQTT integration. If configured, TeslaPi publishes sensor updates to an MQTT broker
                for auto-discovery by Home Assistant. Useful if your HA instance is not directly reachable.
              </p>

              <FormField
                label="MQTT Broker"
                helpText="Hostname or IP of the MQTT broker (e.g., mqtt.local or the HA IP if using the Mosquitto add-on)."
                htmlFor="mqtt-broker"
              >
                <input
                  id="mqtt-broker"
                  type="text"
                  class="text-input"
                  value={config.mqttBroker ?? ''}
                  onInput={(e) => update('mqttBroker', (e.target as HTMLInputElement).value)}
                  placeholder="mqtt.local"
                />
              </FormField>

              <FormField
                label="MQTT Port"
                helpText="Default is 1883 for unencrypted, 8883 for TLS."
                htmlFor="mqtt-port"
              >
                <input
                  id="mqtt-port"
                  type="number"
                  class="text-input"
                  value={config.mqttPort ?? 1883}
                  onInput={(e) => update('mqttPort', parseInt((e.target as HTMLInputElement).value, 10) || 1883)}
                  placeholder="1883"
                />
              </FormField>

              <FormField
                label="MQTT Username"
                helpText="Optional. MQTT broker authentication username."
                htmlFor="mqtt-user"
              >
                <input
                  id="mqtt-user"
                  type="text"
                  class="text-input"
                  value={config.mqttUsername ?? ''}
                  onInput={(e) => update('mqttUsername', (e.target as HTMLInputElement).value)}
                />
              </FormField>

              <FormField
                label="MQTT Password"
                helpText="Optional. MQTT broker authentication password."
                htmlFor="mqtt-pass"
              >
                <input
                  id="mqtt-pass"
                  type="password"
                  class="text-input"
                  value={config.mqttPassword ?? ''}
                  onInput={(e) => update('mqttPassword', (e.target as HTMLInputElement).value)}
                />
              </FormField>
            </div>
          )}

          <div class="settings-divider" />

          <h4 class="settings-subsection-title">Registered Entities</h4>
          <p class="settings-description">
            These sensors and controls will be registered in Home Assistant when the integration is active.
          </p>
          <div class="entity-list">
            {HA_ENTITIES.map(entity => (
              <div key={entity.id} class="entity-item">
                <div class="entity-item__info">
                  <span class="entity-item__id font-mono">{entity.id}</span>
                  <span class="entity-item__name">{entity.name}</span>
                  <span class="entity-item__desc">{entity.description}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div class="settings-actions">
        <button class="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save HA Settings'}
        </button>
      </div>
    </div>
  );
}
