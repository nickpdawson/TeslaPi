import { useState } from 'preact/hooks';
import { Card } from '../common/Card';
import { post, ApiError } from '../../api/client';
import { addNotification } from '../../stores/appState';
import { authConfigured, authenticated } from '../../stores/authState';

/**
 * Set, change, or disable the app password. When no password is set the API is open;
 * setting one turns on the login gate for every browser. Reads/writes the same
 * `/auth/*` endpoints the login screen uses.
 */
export function SecuritySettings() {
  const configured = authConfigured.value === true;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e: Event) {
    e.preventDefault();
    if (busy) return;
    if (next.length < 4) {
      addNotification('error', 'Password must be at least 4 characters');
      return;
    }
    if (next !== confirm) {
      addNotification('error', 'Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await post('/auth/set-password', {
        new_password: next,
        current_password: configured ? current : undefined,
      });
      authConfigured.value = true;
      authenticated.value = true;
      addNotification('success', configured ? 'Password changed' : 'Password set — the login gate is now on');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      addNotification(
        'error',
        err instanceof ApiError && err.status === 403
          ? 'Current password is incorrect'
          : 'Could not update the password',
      );
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (busy) return;
    if (!confirm && !window.confirm('Turn off the login gate? The UI and API will be open to anyone on the network.')) {
      return;
    }
    setBusy(true);
    try {
      await post('/auth/disable');
      authConfigured.value = false;
      addNotification('success', 'Login gate disabled');
    } catch {
      addNotification('error', 'Could not disable the login gate');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h3 style={{ marginBottom: 'var(--space-2)' }}>Security</h3>
      <p class="text-muted" style={{ marginBottom: 'var(--space-3)', fontSize: '0.9rem' }}>
        {configured
          ? 'A password is required to use TeslaPi. Change or disable it below.'
          : 'No password set — the dashboard is open to anyone on the network. Set one to require sign-in.'}
      </p>

      <form onSubmit={save}>
        {configured && (
          <div style={{ marginBottom: 'var(--space-3)' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 'var(--space-1)' }}>
              Current password
            </label>
            <input
              class="input"
              type="password"
              autocomplete="current-password"
              value={current}
              // @ts-ignore preact input event
              onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
            />
          </div>
        )}

        <div style={{ marginBottom: 'var(--space-3)' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 'var(--space-1)' }}>
            {configured ? 'New password' : 'Password'}
          </label>
          <input
            class="input"
            type="password"
            autocomplete="new-password"
            value={next}
            // @ts-ignore preact input event
            onInput={(e) => setNext((e.target as HTMLInputElement).value)}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 'var(--space-4)' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 'var(--space-1)' }}>
            Confirm password
          </label>
          <input
            class="input"
            type="password"
            autocomplete="new-password"
            value={confirm}
            // @ts-ignore preact input event
            onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button type="submit" class="btn btn--primary" disabled={busy}>
            {configured ? 'Change password' : 'Set password'}
          </button>
          {configured && (
            <button type="button" class="btn" onClick={disable} disabled={busy}>
              Disable login
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}
