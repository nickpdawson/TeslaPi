import { useState } from 'preact/hooks';
import { ProvisionProgress } from './ProvisionProgress';

interface FinishStepProps {
  wifiConfig: { ssid: string; password: string };
  storageConfig: {
    camSize: string;
    musicSize: string;
    filesystem: string;
  };
  archiveConfig: {
    type: string;
    server: string;
    path: string;
    username: string;
  };
  isSubmitting: boolean;
  onComplete: () => void;
  onBack: () => void;
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SkipIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

type FinishPhase = 'review' | 'provisioning' | 'complete' | 'error';

export function FinishStep({
  wifiConfig,
  storageConfig,
  archiveConfig,
  isSubmitting,
  onComplete,
  onBack,
}: FinishStepProps) {
  const [phase, setPhase] = useState<FinishPhase>('review');
  const [errorMsg, setErrorMsg] = useState('');

  const wifiConfigured = !!wifiConfig.ssid;
  const archiveConfigured = archiveConfig.type !== 'none' && !!archiveConfig.server;

  const handleComplete = () => {
    // First, trigger the parent's onComplete which saves config + starts provisioning
    // Then show the provisioning view
    onComplete();
    setPhase('provisioning');
  };

  const handleProvisionComplete = () => {
    setPhase('complete');
  };

  const handleProvisionError = (error: string) => {
    setErrorMsg(error);
    setPhase('error');
  };

  // --- Provisioning phase ---
  if (phase === 'provisioning') {
    return (
      <ProvisionProgress
        onComplete={handleProvisionComplete}
        onError={handleProvisionError}
      />
    );
  }

  // --- Completion phase ---
  if (phase === 'complete') {
    return (
      <div class="setup-step">
        <div class="setup-success">
          <div class="setup-success__circle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style={{ strokeDasharray: 60 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 class="setup-success__title">Setup Complete</h2>
          <p class="setup-success__message">
            TeslaPi is configured and ready. Reboot your Pi, then connect it to your Tesla's USB port.
          </p>
        </div>

        <div class="setup-nav" style={{ justifyContent: 'center' }}>
          <button
            class="setup-nav__btn setup-nav__btn--complete"
            onClick={() => { window.location.href = '/'; }}
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // --- Error phase ---
  if (phase === 'error') {
    return (
      <div class="setup-step">
        <h2 class="setup-step__title">Provisioning Error</h2>
        <div class="setup-warning" style={{ marginBottom: 'var(--space-4)' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div class="setup-warning__text">
            {errorMsg || 'An unexpected error occurred during hardware provisioning.'}
          </div>
        </div>
        <p class="setup-step__description">
          You can try running the setup again. Check the log output for details on what went wrong.
        </p>
        <div class="setup-nav">
          <button class="setup-nav__btn setup-nav__btn--back" onClick={onBack}>
            Back
          </button>
          <button
            class="setup-nav__btn setup-nav__btn--next"
            onClick={() => setPhase('provisioning')}
          >
            Retry Provisioning
          </button>
        </div>
      </div>
    );
  }

  // --- Review phase (default) ---
  return (
    <div class="setup-step">
      <h2 class="setup-step__title">Review Configuration</h2>
      <p class="setup-step__description">
        Review your settings below. You can go back to change anything, or complete
        the setup to start using TeslaPi.
      </p>

      <div class="setup-summary">
        {/* WiFi */}
        <div class="setup-summary__section">
          <div class="setup-summary__header">
            <div class={`setup-summary__check ${!wifiConfigured ? 'setup-summary__check--skip' : ''}`}>
              {wifiConfigured ? <CheckIcon /> : <SkipIcon />}
            </div>
            <span class="setup-summary__label">WiFi</span>
          </div>
          <div class="setup-summary__value">
            {wifiConfigured
              ? `Network: ${wifiConfig.ssid}`
              : 'Skipped — configure later in Settings'}
          </div>
        </div>

        {/* Storage */}
        <div class="setup-summary__section">
          <div class="setup-summary__header">
            <div class="setup-summary__check">
              <CheckIcon />
            </div>
            <span class="setup-summary__label">Storage</span>
          </div>
          <div class="setup-summary__value">
            Dashcam: {storageConfig.camSize || '40G'}
            {storageConfig.musicSize && ` / Music: ${storageConfig.musicSize}`}
            {' / '}Filesystem: {storageConfig.filesystem.toUpperCase()}
          </div>
        </div>

        {/* Archive */}
        <div class="setup-summary__section">
          <div class="setup-summary__header">
            <div class={`setup-summary__check ${!archiveConfigured ? 'setup-summary__check--skip' : ''}`}>
              {archiveConfigured ? <CheckIcon /> : <SkipIcon />}
            </div>
            <span class="setup-summary__label">Archive</span>
          </div>
          <div class="setup-summary__value">
            {archiveConfigured
              ? `${archiveConfig.type.toUpperCase()} — ${archiveConfig.server}/${archiveConfig.path}${archiveConfig.username ? ` (user: ${archiveConfig.username})` : ''}`
              : 'Skipped — configure later in Settings'}
          </div>
        </div>
      </div>

      <div class="setup-links">
        <a href="/settings" class="setup-link" onClick={(e) => e.preventDefault()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          Set up Home Assistant integration
        </a>
        <a href="/settings" class="setup-link" onClick={(e) => e.preventDefault()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 01-3.46 0" />
          </svg>
          Configure notifications
        </a>
        <a href="/network" class="setup-link" onClick={(e) => e.preventDefault()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
            <path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z" />
          </svg>
          Set up WireGuard VPN
        </a>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 'var(--space-1)', paddingLeft: 'var(--space-1)' }}>
          These optional features can be configured later from the dashboard.
        </p>
      </div>

      <div class="setup-nav">
        <button class="setup-nav__btn setup-nav__btn--back" onClick={onBack} disabled={isSubmitting}>
          Back
        </button>
        <button
          class="setup-nav__btn setup-nav__btn--complete"
          onClick={handleComplete}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <svg class="animate-spin" style={{ marginRight: '8px', display: 'inline' }} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 11-6.219-8.56" />
              </svg>
              Saving...
            </>
          ) : (
            'Complete Setup'
          )}
        </button>
      </div>
    </div>
  );
}
