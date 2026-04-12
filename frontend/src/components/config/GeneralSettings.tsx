import { useState } from 'preact/hooks';
import { FormField } from '../common/FormField';
import { Select } from '../common/Select';
import type { WiFiConfig } from '../../api/types';

interface GeneralSettingsProps {
  hostname: string;
  timezone: string;
  wifi: WiFiConfig;
  onSave: (updates: { hostname: string; timezone: string; wifi: WiFiConfig }) => Promise<void>;
}

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern (America/New_York)' },
  { value: 'America/Chicago', label: 'Central (America/Chicago)' },
  { value: 'America/Denver', label: 'Mountain (America/Denver)' },
  { value: 'America/Boise', label: 'Mountain (America/Boise)' },
  { value: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (America/Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Pacific/Honolulu)' },
  { value: 'Europe/London', label: 'London (Europe/London)' },
  { value: 'Europe/Berlin', label: 'Berlin (Europe/Berlin)' },
  { value: 'Europe/Helsinki', label: 'Helsinki (Europe/Helsinki)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (Asia/Tokyo)' },
  { value: 'Australia/Sydney', label: 'Sydney (Australia/Sydney)' },
  { value: 'UTC', label: 'UTC' },
];

const WIFI_COUNTRIES = [
  { value: 'US', label: 'United States (US)' },
  { value: 'CA', label: 'Canada (CA)' },
  { value: 'GB', label: 'United Kingdom (GB)' },
  { value: 'DE', label: 'Germany (DE)' },
  { value: 'FR', label: 'France (FR)' },
  { value: 'FI', label: 'Finland (FI)' },
  { value: 'JP', label: 'Japan (JP)' },
  { value: 'AU', label: 'Australia (AU)' },
  { value: 'NZ', label: 'New Zealand (NZ)' },
  { value: 'NO', label: 'Norway (NO)' },
  { value: 'SE', label: 'Sweden (SE)' },
  { value: 'CH', label: 'Switzerland (CH)' },
  { value: 'AT', label: 'Austria (AT)' },
  { value: 'IT', label: 'Italy (IT)' },
  { value: 'ES', label: 'Spain (ES)' },
];

export function GeneralSettings({ hostname: initHostname, timezone: initTimezone, wifi: initWifi, onSave }: GeneralSettingsProps) {
  const [hostname, setHostname] = useState(initHostname);
  const [timezone, setTimezone] = useState(initTimezone);
  const [wifiSsid, setWifiSsid] = useState(initWifi.ssid);
  const [wifiPassword, setWifiPassword] = useState(initWifi.password ?? '');
  const [wifiCountry, setWifiCountry] = useState(initWifi.country);
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({
        hostname,
        timezone,
        wifi: { ssid: wifiSsid, password: wifiPassword || undefined, country: wifiCountry },
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="settings-section">
      <FormField
        label="Hostname"
        helpText="The network hostname for your TeslaPi. Used for mDNS discovery (e.g., teslapi.local). Only lowercase letters, numbers, and hyphens."
        htmlFor="hostname"
      >
        <input
          id="hostname"
          type="text"
          class="text-input"
          value={hostname}
          onInput={(e) => setHostname((e.target as HTMLInputElement).value)}
          placeholder="teslapi"
          pattern="[a-z0-9\-]+"
        />
      </FormField>

      <FormField
        label="Timezone"
        helpText="System timezone. Used for dashcam event timestamps and archive scheduling."
        htmlFor="timezone"
      >
        <Select
          id="timezone"
          options={TIMEZONES}
          value={timezone}
          onChange={setTimezone}
        />
      </FormField>

      <div class="settings-divider" />

      <h4 class="settings-subsection-title">WiFi Configuration</h4>

      <FormField
        label="WiFi Network (SSID)"
        helpText="The WiFi network your TeslaPi connects to when parked. This should be your home network or a hotspot that reaches your garage."
        htmlFor="wifi-ssid"
      >
        <input
          id="wifi-ssid"
          type="text"
          class="text-input"
          value={wifiSsid}
          onInput={(e) => setWifiSsid((e.target as HTMLInputElement).value)}
          placeholder="MyHomeNetwork"
        />
      </FormField>

      <FormField
        label="WiFi Password"
        helpText="WPA2/WPA3 password for your WiFi network. Leave blank for open networks."
        htmlFor="wifi-password"
      >
        <div class="input-with-action">
          <input
            id="wifi-password"
            type={showPassword ? 'text' : 'password'}
            class="text-input"
            value={wifiPassword}
            onInput={(e) => setWifiPassword((e.target as HTMLInputElement).value)}
            placeholder="Enter WiFi password"
          />
          <button
            type="button"
            class="btn btn--ghost btn--sm input-action-btn"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      </FormField>

      <FormField
        label="WiFi Country Code"
        helpText="Required for regulatory compliance. Sets allowed WiFi channels and transmit power for your region."
        htmlFor="wifi-country"
      >
        <Select
          id="wifi-country"
          options={WIFI_COUNTRIES}
          value={wifiCountry}
          onChange={setWifiCountry}
        />
      </FormField>

      <div class="settings-actions">
        <button class="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save General Settings'}
        </button>
      </div>
    </div>
  );
}
