import { useState } from 'preact/hooks';
import { FormField } from '../common/FormField';

interface WiFiStepProps {
  config: {
    ssid: string;
    password: string;
  };
  onChange: (config: { ssid: string; password: string }) => void;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

export function WiFiStep({ config, onChange, onNext, onBack, onSkip }: WiFiStepProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    if (!config.ssid.trim()) {
      newErrors.ssid = 'WiFi network name is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleNext() {
    if (validate()) {
      onNext();
    }
  }

  return (
    <div class="setup-step">
      <h2 class="setup-step__title">WiFi Configuration</h2>
      <p class="setup-step__description">
        Configure the WiFi network TeslaPi will use to archive dashcam footage
        and sync music when parked at home.
      </p>

      <div class="setup-form">
        <FormField
          label="Home WiFi Network (SSID)"
          helpText="The WiFi network name your Tesla connects to at home."
          error={errors.ssid}
          htmlFor="setup-wifi-ssid"
        >
          <input
            id="setup-wifi-ssid"
            type="text"
            class={`setup-input ${errors.ssid ? 'setup-input--error' : ''}`}
            value={config.ssid}
            onInput={(e) => {
              onChange({ ...config, ssid: (e.target as HTMLInputElement).value });
              if (errors.ssid) setErrors({ ...errors, ssid: '' });
            }}
            placeholder="MyHomeWiFi"
          />
        </FormField>

        <FormField
          label="WiFi Password"
          helpText="Leave empty if your network is open (not recommended)."
          htmlFor="setup-wifi-password"
        >
          <div class="relative">
            <input
              id="setup-wifi-password"
              type={showPassword ? 'text' : 'password'}
              class="setup-input"
              value={config.password}
              onInput={(e) => onChange({ ...config, password: (e.target as HTMLInputElement).value })}
              placeholder="Network password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              style={{
                position: 'absolute',
                right: '12px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
                padding: '4px',
                minHeight: 'auto',
                minWidth: 'auto',
              }}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
        </FormField>

        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          background: 'var(--color-card)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border)',
        }}>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-relaxed)' }}>
            Your home WiFi should have the highest priority. TeslaPi will connect to
            this network automatically when in range to archive footage and sync music.
            Additional networks can be configured later in Settings.
          </p>
        </div>
      </div>

      <div class="setup-nav">
        <button class="setup-nav__btn setup-nav__btn--back" onClick={onBack}>
          Back
        </button>
        <div class="flex items-center">
          <button class="setup-nav__btn setup-nav__btn--skip" onClick={onSkip}>
            Skip
          </button>
          <button class="setup-nav__btn setup-nav__btn--next" onClick={handleNext}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
