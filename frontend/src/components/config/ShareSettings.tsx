import { useState } from 'preact/hooks';
import { FormField } from '../common/FormField';
import { Select } from '../common/Select';
import { post } from '../../api/client';
import type { ShareConfig } from '../../api/types';

interface ShareSettingsProps {
  archiveShare?: ShareConfig;
  musicShare?: ShareConfig;
  onSave: (updates: { archiveShare?: ShareConfig; musicShare?: ShareConfig }) => Promise<void>;
}

const SHARE_TYPES = [
  { value: 'cifs', label: 'CIFS / SMB (Windows share)' },
  { value: 'nfs', label: 'NFS (Unix/Linux share)' },
];

interface ShareFormProps {
  title: string;
  description: string;
  share: ShareConfig;
  onChange: (share: ShareConfig) => void;
  testEndpoint: string;
}

function ShareForm({ title, description, share, onChange, testEndpoint }: ShareFormProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  function update(field: keyof ShareConfig, value: string) {
    onChange({ ...share, [field]: value });
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await post<{ success?: boolean; ok?: boolean; message: string }>(testEndpoint, {
        type: share.type,
        server: share.server,
        path: share.path,
        username: share.username ?? '',
        password: share.password ?? '',
        domain: share.domain ?? '',
      });
      setTestResult({ ok: result.success ?? result.ok ?? false, message: result.message });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div class="share-form">
      <h4 class="settings-subsection-title">{title}</h4>
      <p class="settings-description">{description}</p>

      <FormField
        label="Share Type"
        helpText="CIFS/SMB is used for Windows and Samba shares (most common). NFS is used for Unix/Linux NAS devices like TrueNAS or Synology."
      >
        <Select
          options={SHARE_TYPES}
          value={share.type}
          onChange={(v) => update('type', v)}
        />
      </FormField>

      <FormField
        label="Server Address"
        helpText="IP address or hostname of the server hosting the share (e.g., 192.168.1.100 or nas.local)."
        htmlFor={`${title}-server`}
      >
        <input
          id={`${title}-server`}
          type="text"
          class="text-input"
          value={share.server}
          onInput={(e) => update('server', (e.target as HTMLInputElement).value)}
          placeholder="192.168.1.100"
        />
      </FormField>

      <FormField
        label="Share Path"
        helpText="The path to the share on the server. For CIFS, use the share name (e.g., /TeslaCam). For NFS, use the export path (e.g., /mnt/pool/teslacam)."
        htmlFor={`${title}-path`}
      >
        <input
          id={`${title}-path`}
          type="text"
          class="text-input"
          value={share.path}
          onInput={(e) => update('path', (e.target as HTMLInputElement).value)}
          placeholder={share.type === 'cifs' ? '/TeslaCam' : '/mnt/pool/teslacam'}
        />
      </FormField>

      {share.type === 'cifs' && (
        <>
          <FormField
            label="Username"
            helpText="Username for CIFS/SMB authentication. Some NAS devices use 'guest' for public shares."
            htmlFor={`${title}-user`}
          >
            <input
              id={`${title}-user`}
              type="text"
              class="text-input"
              value={share.username ?? ''}
              onInput={(e) => update('username', (e.target as HTMLInputElement).value)}
              placeholder="teslapi"
            />
          </FormField>

          <FormField
            label="Password"
            helpText="Password for the CIFS/SMB share. Stored locally on the Pi."
            htmlFor={`${title}-pass`}
          >
            <input
              id={`${title}-pass`}
              type="password"
              class="text-input"
              value={share.password ?? ''}
              onInput={(e) => update('password', (e.target as HTMLInputElement).value)}
              placeholder="Enter share password"
            />
          </FormField>

          <FormField
            label="Domain"
            helpText="Optional. Active Directory or workgroup domain name (e.g., WORKGROUP)."
            htmlFor={`${title}-domain`}
          >
            <input
              id={`${title}-domain`}
              type="text"
              class="text-input"
              value={share.domain ?? ''}
              onInput={(e) => update('domain', (e.target as HTMLInputElement).value)}
              placeholder="WORKGROUP"
            />
          </FormField>
        </>
      )}

      <div class="settings-advanced-toggle">
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Options'}
        </button>
      </div>

      {showAdvanced && (
        <FormField
          label="Mount Options"
          helpText="Additional mount options passed to the mount command. Comma-separated (e.g., vers=3.0,iocharset=utf8). Leave blank for defaults."
          htmlFor={`${title}-mount-opts`}
        >
          <input
            id={`${title}-mount-opts`}
            type="text"
            class="text-input"
            value={share.mountOptions ?? ''}
            onInput={(e) => update('mountOptions', (e.target as HTMLInputElement).value)}
            placeholder="vers=3.0,iocharset=utf8"
          />
        </FormField>
      )}

      <div class="settings-actions" style={{ marginTop: 'var(--space-4)' }}>
        <button
          class="btn btn--ghost"
          onClick={handleTest}
          disabled={testing || !share.server || !share.path}
        >
          {testing && <span class="animate-spin" style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid var(--color-text-muted)', borderTopColor: 'var(--color-accent)', borderRadius: '50%', marginRight: 'var(--space-2)' }} />}
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
      </div>

      {testResult && (
        <div class={`test-result ${testResult.ok ? 'test-result--success' : 'test-result--error'}`}>
          <span class="test-result__icon">{testResult.ok ? '\u2713' : '\u2717'}</span>
          <span>{testResult.message}</span>
        </div>
      )}
    </div>
  );
}

export function ShareSettings({ archiveShare: initArchive, musicShare: initMusic, onSave }: ShareSettingsProps) {
  const [archiveShare, setArchiveShare] = useState<ShareConfig>(initArchive ?? { type: 'cifs', server: '', path: '' });
  const [musicShare, setMusicShare] = useState<ShareConfig>(initMusic ?? { type: 'cifs', server: '', path: '' });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({ archiveShare, musicShare });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="settings-section">
      <ShareForm
        title="Archive Share"
        description="Where dashcam clips are archived when your car connects to WiFi. The Pi copies sentry and saved clips to this network share automatically."
        share={archiveShare}
        onChange={setArchiveShare}
        testEndpoint="/shares/test"
      />

      <div class="settings-divider" />

      <ShareForm
        title="Music Share"
        description="Optional. A network share containing music files to sync to the USB music drive. Files are copied to the Pi and then presented to the car over USB."
        share={musicShare}
        onChange={setMusicShare}
        testEndpoint="/shares/test"
      />

      <div class="settings-actions">
        <button class="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Share Settings'}
        </button>
      </div>
    </div>
  );
}
