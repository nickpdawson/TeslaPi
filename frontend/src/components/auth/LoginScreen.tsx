import { useState } from 'preact/hooks';
import { login } from '../../stores/authState';
import { ApiError } from '../../api/client';

/**
 * Full-screen login gate. Rendered by the app shell whenever auth is configured and
 * this browser has no valid session. On success the auth store flips `authenticated`
 * and the app re-renders into the normal shell.
 */
export function LoginScreen() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Incorrect password'
          : 'Could not sign in. Check your connection and try again.',
      );
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-4)',
      }}
    >
      <form
        class="card"
        onSubmit={onSubmit}
        style={{ width: '100%', maxWidth: '360px', padding: 'var(--space-5)' }}
      >
        <h1 style={{ marginBottom: 'var(--space-2)', fontSize: '1.4rem' }}>TeslaPi</h1>
        <p class="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
          Enter your password to continue.
        </p>

        <label
          for="teslapi-password"
          style={{ display: 'block', marginBottom: 'var(--space-1)', fontSize: '0.85rem' }}
        >
          Password
        </label>
        <input
          id="teslapi-password"
          class="input"
          type="password"
          autocomplete="current-password"
          value={password}
          // @ts-ignore preact input event
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          disabled={busy}
          autofocus
          style={{ width: '100%', marginBottom: 'var(--space-3)' }}
        />

        {error && (
          <div
            role="alert"
            style={{ color: 'var(--color-danger, #e5484d)', marginBottom: 'var(--space-3)', fontSize: '0.9rem' }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          class="btn btn--primary"
          disabled={busy || !password}
          style={{ width: '100%' }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
