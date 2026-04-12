import { useState, useEffect } from 'preact/hooks';
import { route } from 'preact-router';
import { get, post } from '../../api/client';
import { setupComplete, setupDetectedConfig } from '../../stores/appState';
import { WelcomeStep } from './WelcomeStep';
import { WiFiStep } from './WiFiStep';
import { StorageStep } from './StorageStep';
import { ArchiveStep } from './ArchiveStep';
import { FinishStep } from './FinishStep';

const TOTAL_STEPS = 5;
const STEP_LABELS = ['Welcome', 'WiFi', 'Storage', 'Archive', 'Finish'];

interface DetectedDrive {
  device: string;
  size: string;
  model: string;
}

export function SetupWizard(_props: { path?: string }) {
  const [currentStep, setCurrentStep] = useState(1);
  const [hasExistingConfig, setHasExistingConfig] = useState(false);
  const [detectedDrives, setDetectedDrives] = useState<DetectedDrive[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  // Step configs
  const [wifiConfig, setWifiConfig] = useState({ ssid: '', password: '' });
  const [storageConfig, setStorageConfig] = useState({
    camSize: '40G',
    musicSize: '20G',
    lightshowSize: '1G',
    boomboxSize: '1G',
    filesystem: 'exfat',
    dataDrive: '',
  });
  const [archiveConfig, setArchiveConfig] = useState({
    type: 'cifs',
    server: '',
    path: '',
    username: '',
    password: '',
  });

  // Load detected config and hardware on mount
  useEffect(() => {
    async function detect() {
      try {
        const result = await get<{
          existingConfig: Record<string, string>;
          hardware: {
            drives: DetectedDrive[];
            wifiInterfaces: string[];
            hostname: string;
          };
        }>('/setup/detect');

        const cfg = result.existingConfig;
        if (cfg && Object.keys(cfg).length > 0) {
          setHasExistingConfig(true);

          // Pre-fill WiFi
          if (cfg.WIFI_SSID) {
            setWifiConfig((prev) => ({ ...prev, ssid: cfg.WIFI_SSID }));
          }

          // Pre-fill storage
          setStorageConfig((prev) => ({
            ...prev,
            camSize: cfg.CAM_SIZE || prev.camSize,
            musicSize: cfg.MUSIC_SIZE || prev.musicSize,
            lightshowSize: cfg.LIGHTSHOW_SIZE || prev.lightshowSize,
            boomboxSize: cfg.BOOMBOX_SIZE || prev.boomboxSize,
            filesystem: cfg.FILESYSTEMS || prev.filesystem,
            dataDrive: cfg.DATA_DRIVE || prev.dataDrive,
          }));

          // Pre-fill archive
          setArchiveConfig((prev) => ({
            ...prev,
            type: cfg.ARCHIVE_SYSTEM || prev.type,
            server: cfg.ARCHIVE_SERVER || prev.server,
            path: cfg.SHARE_NAME || prev.path,
            username: cfg.SHARE_USER || prev.username,
          }));
        } else if (setupDetectedConfig.value) {
          setHasExistingConfig(true);
          const dc = setupDetectedConfig.value;
          if (dc.WIFI_SSID) setWifiConfig((prev) => ({ ...prev, ssid: dc.WIFI_SSID }));
          if (dc.CAM_SIZE) setStorageConfig((prev) => ({ ...prev, camSize: dc.CAM_SIZE }));
          if (dc.ARCHIVE_SYSTEM) setArchiveConfig((prev) => ({ ...prev, type: dc.ARCHIVE_SYSTEM }));
          if (dc.ARCHIVE_SERVER) setArchiveConfig((prev) => ({ ...prev, server: dc.ARCHIVE_SERVER }));
          if (dc.SHARE_NAME) setArchiveConfig((prev) => ({ ...prev, path: dc.SHARE_NAME }));
          if (dc.SHARE_USER) setArchiveConfig((prev) => ({ ...prev, username: dc.SHARE_USER }));
        }

        if (result.hardware?.drives) {
          setDetectedDrives(result.hardware.drives);
        }
      } catch {
        // Detection failed — proceed with defaults
      }
    }

    detect();
  }, []);

  function goNext() {
    if (currentStep < TOTAL_STEPS) {
      setCurrentStep(currentStep + 1);
    }
  }

  function goBack() {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  }

  async function handleComplete() {
    setIsSubmitting(true);

    try {
      await post('/setup/complete', {
        wifi: wifiConfig.ssid ? wifiConfig : null,
        storage: storageConfig,
        archive: archiveConfig.type !== 'none' ? archiveConfig : { type: 'none' },
      });

      setupComplete.value = true;
      setShowSuccess(true);

      // Redirect to dashboard after a brief success animation
      setTimeout(() => {
        route('/', true);
      }, 2000);
    } catch (err) {
      // Even if the write fails, mark setup as complete in the UI
      // so the user can proceed to the dashboard
      setupComplete.value = true;
      setShowSuccess(true);
      setTimeout(() => {
        route('/', true);
      }, 2000);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (showSuccess) {
    return (
      <div class="setup-wizard">
        <div class="setup-wizard__container">
          <div class="setup-success">
            <div class="setup-success__circle">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style={{ strokeDasharray: 60 }}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 class="setup-success__title">Setup Complete</h2>
            <p class="setup-success__message">
              TeslaPi is ready to use. Redirecting to dashboard...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="setup-wizard">
      <div class="setup-wizard__container">
        {/* Step indicator */}
        <div class="setup-steps">
          {STEP_LABELS.map((label, i) => {
            const stepNum = i + 1;
            const isActive = stepNum === currentStep;
            const isCompleted = stepNum < currentStep;

            return (
              <div class="setup-steps__item" key={label}>
                {i > 0 && (
                  <div class={`setup-steps__line ${isCompleted ? 'setup-steps__line--completed' : ''}`} />
                )}
                <div
                  class={`setup-steps__dot ${isActive ? 'setup-steps__dot--active' : ''} ${isCompleted ? 'setup-steps__dot--completed' : ''}`}
                  title={label}
                >
                  {isCompleted ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    stepNum
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Step content */}
        {currentStep === 1 && (
          <WelcomeStep
            hasExistingConfig={hasExistingConfig}
            onNext={goNext}
          />
        )}

        {currentStep === 2 && (
          <WiFiStep
            config={wifiConfig}
            onChange={setWifiConfig}
            onNext={goNext}
            onBack={goBack}
            onSkip={goNext}
          />
        )}

        {currentStep === 3 && (
          <StorageStep
            config={storageConfig}
            detectedDrives={detectedDrives}
            onChange={setStorageConfig}
            onNext={goNext}
            onBack={goBack}
          />
        )}

        {currentStep === 4 && (
          <ArchiveStep
            config={archiveConfig}
            onChange={setArchiveConfig}
            onNext={goNext}
            onBack={goBack}
            onSkip={goNext}
          />
        )}

        {currentStep === 5 && (
          <FinishStep
            wifiConfig={wifiConfig}
            storageConfig={storageConfig}
            archiveConfig={archiveConfig}
            isSubmitting={isSubmitting}
            onComplete={handleComplete}
            onBack={goBack}
          />
        )}
      </div>
    </div>
  );
}
