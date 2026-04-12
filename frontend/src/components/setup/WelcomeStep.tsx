interface WelcomeStepProps {
  hasExistingConfig: boolean;
  onNext: () => void;
}

export function WelcomeStep({ hasExistingConfig, onNext }: WelcomeStepProps) {
  return (
    <div class="setup-step">
      <div class="setup-welcome__logo">
        <div class="setup-welcome__logo-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
            <polyline points="12 2 12 7" />
            <circle cx="12" cy="14" r="3" />
          </svg>
        </div>
        <h1 class="setup-welcome__title">Welcome to TeslaPi</h1>
        <p class="setup-welcome__subtitle">
          Turn your Raspberry Pi into a smart Tesla USB drive with dashcam archiving,
          music syncing, and Home Assistant integration.
        </p>
      </div>

      {hasExistingConfig && (
        <div class="setup-welcome__existing">
          <svg class="setup-welcome__existing-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <div class="setup-welcome__existing-text">
            We found an existing teslausb configuration. Your settings have been
            pre-filled below — review and adjust as needed.
          </div>
        </div>
      )}

      <div class="setup-welcome__features">
        <div class="setup-welcome__feature">
          <div class="setup-welcome__feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>
          <span class="setup-welcome__feature-name">Dashcam Archiving</span>
        </div>
        <div class="setup-welcome__feature">
          <div class="setup-welcome__feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <span class="setup-welcome__feature-name">Music Sync</span>
        </div>
        <div class="setup-welcome__feature">
          <div class="setup-welcome__feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </div>
          <span class="setup-welcome__feature-name">Home Assistant</span>
        </div>
        <div class="setup-welcome__feature">
          <div class="setup-welcome__feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
          </div>
          <span class="setup-welcome__feature-name">Notifications</span>
        </div>
      </div>

      <div class="setup-nav" style="border-top: none; padding-top: 0;">
        <div />
        <button class="setup-nav__btn setup-nav__btn--next" onClick={onNext}>
          Get Started
        </button>
      </div>
    </div>
  );
}
