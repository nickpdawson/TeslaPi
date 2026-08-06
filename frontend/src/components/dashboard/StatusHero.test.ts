import { describe, it, expect } from 'vitest';
import type { TeslaPiStatus } from '../../api/types';
import { getRingLabel } from './StatusHero';

// Minimal status factory — getRingLabel only reads state + archive.status.
function status(state: TeslaPiStatus['state'], archiveStatus = 'idle'): TeslaPiStatus {
  return { state, archive: { status: archiveStatus } } as unknown as TeslaPiStatus;
}

describe('StatusHero ring label (iter 29 — reflect backend state, not archive alone)', () => {
  it('maps each backend state to its label', () => {
    expect(getRingLabel(status('archiving'))).toBe('Archiving');
    expect(getRingLabel(status('syncing'))).toBe('Syncing');
    expect(getRingLabel(status('error'))).toBe('Error');
    expect(getRingLabel(status('offline'))).toBe('Offline');
    expect(getRingLabel(status('connected'))).toBe('Connected');
    expect(getRingLabel(status('idle'))).toBe('All Systems Go');
  });

  it('surfaces an unreachable archive server when the top-level state is otherwise fine', () => {
    expect(getRingLabel(status('idle', 'unreachable'))).toBe('Server Unreachable');
    expect(getRingLabel(status('connected', 'unreachable'))).toBe('Server Unreachable');
  });

  it('a syncing state (happening now) outranks an unreachable archive note', () => {
    expect(getRingLabel(status('syncing', 'unreachable'))).toBe('Syncing');
  });
});
