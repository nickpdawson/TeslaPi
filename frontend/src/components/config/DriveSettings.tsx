import { useState } from 'preact/hooks';
import { FormField } from '../common/FormField';
import { Select } from '../common/Select';
import { Toggle } from '../common/Toggle';
import type { DriveConfig } from '../../api/types';

interface DriveSettingsProps {
  drives: DriveConfig[];
  dataDrive: string;
  onSave: (updates: { drives: DriveConfig[]; dataDrive: string }) => Promise<void>;
}

const FS_OPTIONS = [
  { value: 'ext4', label: 'ext4 (Linux native, faster)' },
  { value: 'exfat', label: 'exFAT (cross-platform, readable on Windows/Mac)' },
];

const DRIVE_DESCRIPTIONS: Record<string, string> = {
  cam: 'Dashcam storage. Tesla writes sentry clips, saved clips, and recent recordings here. This is typically the largest drive.',
  music: 'Music drive presented to the car via USB. Place audio files here for playback through the Tesla media player.',
  lightshow: 'Custom light show files (.fseq) that Tesla reads to play choreographed light shows.',
  boombox: 'Boombox sound files (.wav) played through the external speaker when using the Boombox feature (requires Premium Connectivity or physical speaker).',
};

export function DriveSettings({ drives: initDrives, dataDrive: initDataDrive, onSave }: DriveSettingsProps) {
  const [drives, setDrives] = useState<DriveConfig[]>(initDrives);
  const [dataDrive, setDataDrive] = useState(initDataDrive);
  const [saving, setSaving] = useState(false);

  function updateDrive(index: number, field: keyof DriveConfig, value: string | boolean) {
    const updated = [...drives];
    updated[index] = { ...updated[index], [field]: value };
    setDrives(updated);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({ drives, dataDrive });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="settings-section">
      <div class="settings-warning">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div>
          <strong>Changing drive sizes requires re-creation of backing files.</strong>
          <p style={{ marginTop: 'var(--space-1)' }}>
            This is a destructive operation that will erase all data on the affected drive.
            Make sure your dashcam clips are archived before changing sizes.
          </p>
        </div>
      </div>

      {drives.map((drive, idx) => (
        <div key={drive.name} class="drive-card">
          <div class="drive-card__header">
            <div class="drive-card__info">
              <h4 class="drive-card__name">{drive.name}</h4>
              <p class="drive-card__desc">{DRIVE_DESCRIPTIONS[drive.name] ?? ''}</p>
            </div>
            <Toggle
              checked={drive.enabled}
              onChange={(v) => updateDrive(idx, 'enabled', v)}
              label={drive.enabled ? 'Enabled' : 'Disabled'}
            />
          </div>

          {drive.enabled && (
            <div class="drive-card__fields">
              <FormField
                label="Size"
                helpText="Size of the virtual USB drive image. Use suffixes: G for gigabytes, M for megabytes (e.g., 140G, 500M). Total of all drives must not exceed the physical USB storage."
              >
                <input
                  type="text"
                  class="text-input"
                  value={drive.size}
                  onInput={(e) => updateDrive(idx, 'size', (e.target as HTMLInputElement).value)}
                  placeholder="140G"
                  pattern="[0-9]+(G|M|K)"
                />
              </FormField>

              <FormField
                label="Filesystem"
                helpText="ext4 is faster and supports Linux permissions. exFAT is readable on Windows and macOS if you remove the drive. Tesla requires exFAT for the cam drive."
              >
                <Select
                  options={FS_OPTIONS}
                  value={drive.filesystem}
                  onChange={(v) => updateDrive(idx, 'filesystem', v)}
                />
              </FormField>
            </div>
          )}
        </div>
      ))}

      <div class="settings-divider" />

      <FormField
        label="Data Drive"
        helpText="The physical USB storage device used to create virtual drive images. This is typically the USB SSD or flash drive plugged into the Pi. Detected devices are listed below."
      >
        <input
          type="text"
          class="text-input"
          value={dataDrive}
          onInput={(e) => setDataDrive((e.target as HTMLInputElement).value)}
          placeholder="/dev/sda"
        />
      </FormField>

      <div class="settings-actions">
        <button class="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Drive Settings'}
        </button>
      </div>
    </div>
  );
}
