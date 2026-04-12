import { useState } from 'preact/hooks';
import { FormField } from '../common/FormField';
import { Toggle } from '../common/Toggle';
import { addNotification } from '../../stores/appState';

interface AddWiFiModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (ssid: string, password: string, priority: number, autoConnect: boolean, hidden: boolean) => Promise<void>;
  prefillSsid?: string;
}

export function AddWiFiModal({ open, onClose, onAdd, prefillSsid }: AddWiFiModalProps) {
  const [ssid, setSsid] = useState(prefillSsid ?? '');
  const [password, setPassword] = useState('');
  const [priority, setPriority] = useState(10);
  const [autoConnect, setAutoConnect] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Reset form when modal opens with new prefill
  if (open && prefillSsid && ssid !== prefillSsid) {
    setSsid(prefillSsid);
    setPassword('');
    setPriority(10);
    setAutoConnect(true);
    setHidden(false);
    setTestResult(null);
  }

  async function handleSubmit() {
    if (!ssid.trim()) {
      addNotification('error', 'SSID is required');
      return;
    }

    setSaving(true);
    setTestResult(null);
    try {
      await onAdd(ssid.trim(), password, priority, autoConnect, hidden);
      setTestResult({ success: true, message: `Successfully added ${ssid}` });
      addNotification('success', `Added ${ssid}`);
      // Brief delay then close
      setTimeout(() => {
        handleClose();
      }, 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add network';
      setTestResult({ success: false, message: msg });
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    setSsid('');
    setPassword('');
    setPriority(10);
    setAutoConnect(true);
    setHidden(false);
    setShowPassword(false);
    setTestResult(null);
    onClose();
  }

  if (!open) return null;

  return (
    <div class="modal-overlay" onClick={handleClose}>
      <div class="modal-card animate-fade-in" style={{ maxWidth: '520px' }} onClick={(e) => e.stopPropagation()}>
        <h3 class="modal-title">Add WiFi Network</h3>

        <div style={{ marginBottom: 'var(--space-4)' }}>
          <FormField
            label="Network Name (SSID)"
            helpText="The name of the WiFi network to connect to."
            htmlFor="add-wifi-ssid"
          >
            <input
              id="add-wifi-ssid"
              type="text"
              class="text-input"
              value={ssid}
              onInput={(e) => setSsid((e.target as HTMLInputElement).value)}
              placeholder="MyNetwork"
              disabled={!!prefillSsid}
            />
          </FormField>

          <FormField
            label="Password"
            helpText="WPA2/WPA3 password. Leave blank for open networks."
            htmlFor="add-wifi-password"
          >
            <div class="input-with-action">
              <input
                id="add-wifi-password"
                type={showPassword ? 'text' : 'password'}
                class="text-input"
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
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
            label="Priority"
            helpText="Higher numbers connect first. Set your home WiFi highest (e.g., 100), hotspot lower (e.g., 10)."
            htmlFor="add-wifi-priority"
          >
            <input
              id="add-wifi-priority"
              type="number"
              class="text-input"
              value={priority}
              onInput={(e) => setPriority(parseInt((e.target as HTMLInputElement).value, 10) || 0)}
              min={0}
              max={999}
              style={{ maxWidth: '120px' }}
            />
          </FormField>

          <div style={{ marginBottom: 'var(--space-3)' }}>
            <Toggle
              checked={autoConnect}
              onChange={setAutoConnect}
              label="Auto-connect when in range"
            />
          </div>

          <div>
            <Toggle
              checked={hidden}
              onChange={setHidden}
              label="Hidden network (does not broadcast SSID)"
            />
          </div>

          {testResult && (
            <div class={`test-result ${testResult.success ? 'test-result--success' : 'test-result--error'}`}>
              <span class="test-result__icon">{testResult.success ? 'OK' : '!!'}</span>
              {testResult.message}
            </div>
          )}
        </div>

        <div class="modal-actions">
          <button class="btn btn--ghost" onClick={handleClose}>Cancel</button>
          <button
            class="btn btn--primary"
            onClick={handleSubmit}
            disabled={saving || !ssid.trim()}
          >
            {saving ? 'Adding...' : 'Test & Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
