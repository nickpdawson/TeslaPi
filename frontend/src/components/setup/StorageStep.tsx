import { useState } from 'preact/hooks';
import { FormField } from '../common/FormField';
import { Select } from '../common/Select';

interface StorageConfig {
  camSize: string;
  musicSize: string;
  lightshowSize: string;
  boomboxSize: string;
  filesystem: string;
  dataDrive: string;
}

interface DetectedDrive {
  device: string;
  size: string;
  model: string;
}

interface StorageStepProps {
  config: StorageConfig;
  detectedDrives: DetectedDrive[];
  onChange: (config: StorageConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

function parseSizeGB(size: string): number {
  const num = parseFloat(size.replace(/[GMT]/gi, ''));
  if (isNaN(num)) return 0;
  if (/T/i.test(size)) return num * 1024;
  if (/M/i.test(size)) return num / 1024;
  return num;
}

function parseDriveSizeGB(size: string): number {
  const num = parseFloat(size);
  if (isNaN(num)) return 0;
  if (/T/i.test(size)) return num * 1024;
  if (/G/i.test(size)) return num;
  if (/M/i.test(size)) return num / 1024;
  return num;
}

function formatSize(gb: number): string {
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb < 1) return `${Math.round(gb * 1024)} MB`;
  return `${Math.round(gb)} GB`;
}

function isRealDrive(drive: DetectedDrive): boolean {
  // Filter out zram (swap), loop devices, and the boot SD card
  if (drive.device.includes('zram')) return false;
  if (drive.device.includes('loop')) return false;
  if (drive.device.includes('ram')) return false;
  return true;
}

export function StorageStep({ config, detectedDrives, onChange, onNext, onBack }: StorageStepProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const realDrives = detectedDrives.filter(isRealDrive);
  const selectedDrive = realDrives.find(d => d.device === config.dataDrive) || realDrives[0];
  const driveCapacityGB = selectedDrive ? parseDriveSizeGB(selectedDrive.size) : 0;

  const RESERVED_GB = 6;
  const camGB = parseSizeGB(config.camSize);
  const musicGB = parseSizeGB(config.musicSize);
  const lightshowGB = parseSizeGB(config.lightshowSize);
  const boomboxGB = parseSizeGB(config.boomboxSize);
  const usedGB = camGB + musicGB + lightshowGB + boomboxGB + RESERVED_GB;
  const remainingGB = driveCapacityGB - usedGB;
  const usagePct = driveCapacityGB > 0 ? Math.min((usedGB / driveCapacityGB) * 100, 100) : 0;

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!config.dataDrive && realDrives.length > 0) {
      newErrors.dataDrive = 'Select a drive for TeslaPi storage';
    }
    if (!config.camSize.trim()) {
      newErrors.camSize = 'Dashcam size is required';
    }
    if (remainingGB < 0 && driveCapacityGB > 0) {
      newErrors.camSize = 'Total exceeds drive capacity. Reduce sizes.';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleNext() {
    if (validate()) onNext();
  }

  function selectDrive(device: string) {
    onChange({ ...config, dataDrive: device });
    if (errors.dataDrive) setErrors({ ...errors, dataDrive: '' });
  }

  return (
    <div class="setup-step">
      <h2 class="setup-step__title">Storage Configuration</h2>
      <p class="setup-step__description">
        Select a drive and configure how TeslaPi partitions it for dashcam footage,
        music, and other Tesla features.
      </p>

      {realDrives.length > 0 && (
        <div class="setup-card">
          <div class="setup-card__header">
            <span class="setup-card__title">Select Data Drive</span>
          </div>
          {errors.dataDrive && (
            <div style={{ color: 'var(--color-error)', fontSize: 'var(--text-sm)', marginBottom: 'var(--space-2)' }}>
              {errors.dataDrive}
            </div>
          )}
          <div class="setup-drives">
            {realDrives.map((drive) => (
              <div
                class={`setup-drive ${config.dataDrive === drive.device ? 'setup-drive--selected' : ''}`}
                key={drive.device}
                onClick={() => selectDrive(drive.device)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectDrive(drive.device); }}
              >
                <div class="setup-drive__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                    <line x1="6" y1="6" x2="6.01" y2="6" />
                    <line x1="6" y1="18" x2="6.01" y2="18" />
                  </svg>
                </div>
                <div class="setup-drive__info">
                  <div class="setup-drive__name">{drive.model || drive.device}</div>
                  <div class="setup-drive__detail">{drive.device} — {drive.size}</div>
                </div>
                {config.dataDrive === drive.device && (
                  <div class="setup-drive__check">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                )}
              </div>
            ))}
          </div>

          {selectedDrive && (
            <div class="setup-capacity">
              <div class="setup-capacity__bar">
                <div
                  class={`setup-capacity__fill ${remainingGB < 0 ? 'setup-capacity__fill--over' : usagePct > 80 ? 'setup-capacity__fill--warn' : ''}`}
                  style={{ width: `${Math.min(usagePct, 100)}%` }}
                />
              </div>
              <div class="setup-capacity__legend">
                <span>
                  {remainingGB >= 0
                    ? `${formatSize(remainingGB)} remaining of ${formatSize(driveCapacityGB)}`
                    : `${formatSize(Math.abs(remainingGB))} over capacity!`
                  }
                </span>
                <span class="setup-capacity__breakdown">
                  Cam: {formatSize(camGB)}
                  {musicGB > 0 ? ` + Music: ${formatSize(musicGB)}` : ''}
                  {lightshowGB > 0 ? ` + LS: ${formatSize(lightshowGB)}` : ''}
                  {boomboxGB > 0 ? ` + BB: ${formatSize(boomboxGB)}` : ''}
                  {` + ${RESERVED_GB}GB reserved`}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <div class="setup-form">
        <FormField
          label="Dashcam Size"
          helpText="40GB recommended for typical use. Your Tesla records about 10GB per hour of Sentry events."
          error={errors.camSize}
          htmlFor="setup-cam-size"
        >
          <div class="setup-size-input">
            <input
              id="setup-cam-size"
              type="number"
              class={`setup-input ${errors.camSize ? 'setup-input--error' : ''}`}
              value={config.camSize.replace(/[GM]$/i, '')}
              onInput={(e) => {
                const val = (e.target as HTMLInputElement).value;
                onChange({ ...config, camSize: val ? `${val}G` : '' });
                if (errors.camSize) setErrors({ ...errors, camSize: '' });
              }}
              placeholder="40"
              min="10"
            />
            <span class="setup-size-input__suffix">GB</span>
          </div>
        </FormField>

        <FormField
          label="Music Size"
          helpText={
            selectedDrive && musicGB === 0
              ? 'Leave at 0 to skip the music drive, or set a size to enable music syncing.'
              : selectedDrive
                ? `Set to match your music library. ${formatSize(remainingGB + musicGB)} available.`
                : 'Set to match your music library size. Leave empty or set to 0 to skip.'
          }
          htmlFor="setup-music-size"
        >
          <div class="setup-size-input">
            <input
              id="setup-music-size"
              type="number"
              class="setup-input"
              value={config.musicSize.replace(/[GM]$/i, '')}
              onInput={(e) => {
                const val = (e.target as HTMLInputElement).value;
                onChange({ ...config, musicSize: val ? `${val}G` : '' });
              }}
              placeholder="0"
              min="0"
            />
            <span class="setup-size-input__suffix">GB</span>
          </div>
        </FormField>

        <FormField label="Filesystem" helpText="exFAT is recommended — it matches Tesla's native format." htmlFor="setup-fs">
          <Select
            id="setup-fs"
            options={[
              { value: 'exfat', label: 'exFAT (recommended)' },
              { value: 'ext4', label: 'ext4' },
            ]}
            value={config.filesystem}
            onChange={(val) => onChange({ ...config, filesystem: val })}
          />
        </FormField>

        <div class="setup-advanced">
          <button
            class={`setup-advanced__toggle ${showAdvanced ? 'setup-advanced__toggle--open' : ''}`}
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Advanced options
          </button>

          {showAdvanced && (
            <div class="setup-advanced__content">
              <div class="setup-form">
                <FormField
                  label="Lightshow Size"
                  helpText="Space for Tesla light show sequences. 1GB is usually enough."
                  htmlFor="setup-lightshow-size"
                >
                  <div class="setup-size-input">
                    <input
                      id="setup-lightshow-size"
                      type="number"
                      class="setup-input"
                      value={config.lightshowSize.replace(/[GM]$/i, '')}
                      onInput={(e) => {
                        const val = (e.target as HTMLInputElement).value;
                        onChange({ ...config, lightshowSize: val ? `${val}G` : '' });
                      }}
                      placeholder="1"
                      min="0"
                    />
                    <span class="setup-size-input__suffix">GB</span>
                  </div>
                </FormField>

                <FormField
                  label="Boombox Size"
                  helpText="Space for Tesla boombox audio files."
                  htmlFor="setup-boombox-size"
                >
                  <div class="setup-size-input">
                    <input
                      id="setup-boombox-size"
                      type="number"
                      class="setup-input"
                      value={config.boomboxSize.replace(/[GM]$/i, '')}
                      onInput={(e) => {
                        const val = (e.target as HTMLInputElement).value;
                        onChange({ ...config, boomboxSize: val ? `${val}G` : '' });
                      }}
                      placeholder="1"
                      min="0"
                    />
                    <span class="setup-size-input__suffix">GB</span>
                  </div>
                </FormField>
              </div>
            </div>
          )}
        </div>

        <div class="setup-warning">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span class="setup-warning__text">
            The selected drive will be wiped and repartitioned. All existing data on it will be erased.
          </span>
        </div>
      </div>

      <div class="setup-nav">
        <button class="setup-nav__btn setup-nav__btn--back" onClick={onBack}>
          Back
        </button>
        <button class="setup-nav__btn setup-nav__btn--next" onClick={handleNext}>
          Next
        </button>
      </div>
    </div>
  );
}
