import { describe, it, expect } from 'vitest';
import { shouldApplyListing } from './useFiles';

describe('shouldApplyListing (drive-switch stale-response guard, iters 17/18)', () => {
  it('applies a response that is both latest and for the current drive', () => {
    expect(shouldApplyListing(5, 5, 'music', 'music')).toBe(true);
  });

  it('drops a superseded response (seq behind the latest)', () => {
    // A newer navigate bumped the sequence while this one was in flight.
    expect(shouldApplyListing(4, 5, 'music', 'music')).toBe(false);
  });

  it('drops a response for a drive no longer on screen (the wrong-drive bug)', () => {
    // Stale-mutation navigate: seq is newest, but it was issued for the old drive.
    expect(shouldApplyListing(6, 6, 'music', 'boombox')).toBe(false);
  });

  it('drops when both seq and drive are stale', () => {
    expect(shouldApplyListing(4, 6, 'music', 'boombox')).toBe(false);
  });
});
