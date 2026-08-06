import { describe, it, expect } from 'vitest';
import { wifiSignalKnown, getWifiLabel } from './SystemCard';

describe('WiFi signal labeling (iter 29 — no "Excellent" at 0 dBm)', () => {
  it('treats 0 / non-negative / non-finite as unknown, not a real signal', () => {
    expect(wifiSignalKnown(0)).toBe(false);
    expect(wifiSignalKnown(50)).toBe(false);
    expect(wifiSignalKnown(NaN)).toBe(false);
    expect(getWifiLabel(0)).toBe('Unknown'); // the bug: used to be "Excellent"
    expect(getWifiLabel(50)).toBe('Unknown');
  });

  it('labels real negative-dBm signals by strength', () => {
    expect(wifiSignalKnown(-42)).toBe(true);
    expect(getWifiLabel(-42)).toBe('Excellent');
    expect(getWifiLabel(-55)).toBe('Good');
    expect(getWifiLabel(-65)).toBe('Fair');
    expect(getWifiLabel(-80)).toBe('Weak');
  });
});
