import { signal, computed } from '@preact/signals';
import { get, post, setUnauthorizedHandler } from '../api/client';

// null = not yet checked. `configured` = a password has been set (gate active).
// `authenticated` = this browser has a valid session (always true when not configured).
export const authConfigured = signal<boolean | null>(null);
export const authenticated = signal<boolean>(true);

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}

/** Whether to show the login screen instead of the app. */
export function shouldShowLogin(
  configured: boolean | null,
  isAuthed: boolean,
): boolean {
  return configured === true && !isAuthed;
}

export const needsLogin = computed(() =>
  shouldShowLogin(authConfigured.value, authenticated.value),
);

export async function checkAuth(): Promise<void> {
  try {
    const s = await get<AuthStatus>('/auth/status');
    authConfigured.value = s.configured;
    authenticated.value = s.authenticated;
  } catch {
    // /auth/status is unauthenticated and should not fail; if it does (backend down),
    // don't fabricate an authenticated session — leave configured unknown (null) so the
    // app shows its normal loading/offline handling rather than flashing the login form.
    authConfigured.value = authConfigured.value ?? false;
  }
}

export async function login(password: string): Promise<void> {
  await post('/auth/login', { password });
  authenticated.value = true;
  authConfigured.value = true;
}

export async function logout(): Promise<void> {
  try {
    await post('/auth/logout');
  } finally {
    authenticated.value = false;
  }
}

// A 401 from any API call means the session expired or was never established — flip to
// the login screen. Wired from the API client so it works no matter which call tripped.
export function onUnauthorized(): void {
  if (authConfigured.value) {
    authenticated.value = false;
  } else {
    // We hit a 401 but thought auth was off — resync so the login screen appears.
    authConfigured.value = true;
    authenticated.value = false;
  }
}

// Any 401 from the client flips us to the login screen.
setUnauthorizedHandler(onUnauthorized);

// Kick off the auth check at load (alongside setup check).
checkAuth();
