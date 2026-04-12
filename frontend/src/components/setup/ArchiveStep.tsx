import { useState } from 'preact/hooks';
import { post } from '../../api/client';
import { FormField } from '../common/FormField';

interface ArchiveConfig {
  type: string;
  server: string;
  path: string;
  username: string;
  password: string;
}

interface ArchiveStepProps {
  config: ArchiveConfig;
  onChange: (config: ArchiveConfig) => void;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

export function ArchiveStep({ config, onChange, onNext, onBack, onSkip }: ArchiveStepProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ status: 'idle' | 'testing' | 'success' | 'error'; message: string }>({
    status: 'idle',
    message: '',
  });
  const [showPassword, setShowPassword] = useState(false);

  function validate(): boolean {
    if (config.type === 'none') return true;

    const newErrors: Record<string, string> = {};
    if (!config.server.trim()) {
      newErrors.server = 'Server address is required';
    }
    if (!config.path.trim()) {
      newErrors.path = 'Share path is required';
    }
    if (config.type === 'cifs' && !config.username.trim()) {
      newErrors.username = 'Username is required for CIFS shares';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleNext() {
    if (validate()) {
      onNext();
    }
  }

  async function handleTestConnection() {
    if (!validate()) return;

    setTestResult({ status: 'testing', message: 'Testing connection...' });

    try {
      const result = await post<{ valid: boolean; message: string }>('/setup/validate', {
        step: 'archive',
        config: { ...config, testConnection: true },
      });

      if (result.valid) {
        setTestResult({ status: 'success', message: result.message || 'Connection successful' });
      } else {
        setTestResult({ status: 'error', message: result.message || 'Connection failed' });
      }
    } catch (err) {
      setTestResult({
        status: 'error',
        message: err instanceof Error ? err.message : 'Connection test failed',
      });
    }
  }

  return (
    <div class="setup-step">
      <h2 class="setup-step__title">Archive Configuration</h2>
      <p class="setup-step__description">
        Configure where TeslaPi archives dashcam footage. Clips are automatically
        copied to your network share when connected to WiFi.
      </p>

      <div class="setup-archive-types">
        {(['cifs', 'nfs', 'none'] as const).map((type) => (
          <button
            key={type}
            class={`setup-archive-type ${config.type === type ? 'setup-archive-type--active' : ''}`}
            onClick={() => {
              onChange({ ...config, type });
              setErrors({});
              setTestResult({ status: 'idle', message: '' });
            }}
          >
            {type === 'cifs' ? 'CIFS / SMB' : type === 'nfs' ? 'NFS' : 'None'}
          </button>
        ))}
      </div>

      {config.type !== 'none' && (
        <div class="setup-form">
          <FormField
            label="Server Address"
            helpText="IP address or hostname of your file server."
            error={errors.server}
            htmlFor="setup-archive-server"
          >
            <input
              id="setup-archive-server"
              type="text"
              class={`setup-input ${errors.server ? 'setup-input--error' : ''}`}
              value={config.server}
              onInput={(e) => {
                onChange({ ...config, server: (e.target as HTMLInputElement).value });
                if (errors.server) setErrors({ ...errors, server: '' });
              }}
              placeholder="192.168.1.100"
            />
          </FormField>

          <FormField
            label="Share Path"
            helpText={config.type === 'cifs' ? 'The share name on the server (e.g., teslacam).' : 'The NFS export path (e.g., /mnt/pool/teslacam).'}
            error={errors.path}
            htmlFor="setup-archive-path"
          >
            <input
              id="setup-archive-path"
              type="text"
              class={`setup-input ${errors.path ? 'setup-input--error' : ''}`}
              value={config.path}
              onInput={(e) => {
                onChange({ ...config, path: (e.target as HTMLInputElement).value });
                if (errors.path) setErrors({ ...errors, path: '' });
              }}
              placeholder={config.type === 'cifs' ? 'teslacam' : '/mnt/pool/teslacam'}
            />
          </FormField>

          {config.type === 'cifs' && (
            <>
              <FormField
                label="Username"
                helpText="Your network share username."
                error={errors.username}
                htmlFor="setup-archive-user"
              >
                <input
                  id="setup-archive-user"
                  type="text"
                  class={`setup-input ${errors.username ? 'setup-input--error' : ''}`}
                  value={config.username}
                  onInput={(e) => {
                    onChange({ ...config, username: (e.target as HTMLInputElement).value });
                    if (errors.username) setErrors({ ...errors, username: '' });
                  }}
                  placeholder="tesla"
                />
              </FormField>

              <FormField
                label="Password"
                helpText="Your network share password."
                htmlFor="setup-archive-password"
              >
                <div class="relative">
                  <input
                    id="setup-archive-password"
                    type={showPassword ? 'text' : 'password'}
                    class="setup-input"
                    value={config.password}
                    onInput={(e) => onChange({ ...config, password: (e.target as HTMLInputElement).value })}
                    placeholder="Share password"
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
            </>
          )}

          <div>
            <button
              class={`setup-test-btn ${testResult.status === 'success' ? 'setup-test-btn--success' : ''} ${testResult.status === 'error' ? 'setup-test-btn--error' : ''}`}
              onClick={handleTestConnection}
              disabled={testResult.status === 'testing'}
            >
              {testResult.status === 'testing' ? (
                <svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 12a9 9 0 11-6.219-8.56" />
                </svg>
              ) : testResult.status === 'success' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : testResult.status === 'error' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              )}
              {testResult.status === 'testing'
                ? 'Testing...'
                : testResult.status === 'success'
                  ? testResult.message
                  : testResult.status === 'error'
                    ? testResult.message
                    : 'Test Connection'}
            </button>
          </div>
        </div>
      )}

      {config.type === 'none' && (
        <div style={{
          padding: 'var(--space-4)',
          background: 'var(--color-card)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border)',
          textAlign: 'center',
        }}>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
            Without archiving, dashcam clips will only be stored on the USB drive.
            You can configure archiving later in Settings.
          </p>
        </div>
      )}

      <div class="setup-nav">
        <button class="setup-nav__btn setup-nav__btn--back" onClick={onBack}>
          Back
        </button>
        <div class="flex items-center">
          {config.type !== 'none' && (
            <button class="setup-nav__btn setup-nav__btn--skip" onClick={onSkip}>
              Skip
            </button>
          )}
          <button class="setup-nav__btn setup-nav__btn--next" onClick={handleNext}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
