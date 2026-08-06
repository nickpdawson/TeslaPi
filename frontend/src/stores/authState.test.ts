import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldShowLogin,
  onUnauthorized,
  authConfigured,
  authenticated,
} from './authState';

describe('shouldShowLogin', () => {
  it('shows login only when configured and not authenticated', () => {
    expect(shouldShowLogin(true, false)).toBe(true);
    expect(shouldShowLogin(true, true)).toBe(false);   // logged in
    expect(shouldShowLogin(false, false)).toBe(false); // gate off
    expect(shouldShowLogin(null, false)).toBe(false);  // unknown -> don't flash login
  });
});

describe('onUnauthorized', () => {
  beforeEach(() => {
    authConfigured.value = true;
    authenticated.value = true;
  });

  it('flips authenticated off when a 401 arrives on a configured gate', () => {
    onUnauthorized();
    expect(authenticated.value).toBe(false);
    expect(shouldShowLogin(authConfigured.value, authenticated.value)).toBe(true);
  });

  it('marks configured on a surprise 401 (thought auth was off)', () => {
    authConfigured.value = false;
    authenticated.value = true;
    onUnauthorized();
    expect(authConfigured.value).toBe(true);
    expect(authenticated.value).toBe(false);
  });
});
