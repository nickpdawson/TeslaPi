import { describe, it, expect } from 'vitest';
import { formatDetail } from './client';

describe('formatDetail (FastAPI error parsing, iter 22 / SOL-023)', () => {
  it('passes a string detail through as the message', () => {
    expect(formatDetail('Delete requires confirm=true')).toEqual({
      message: 'Delete requires confirm=true',
    });
  });

  it('turns a 422 validation array into a readable message + field errors', () => {
    const result = formatDetail([
      { loc: ['body', 'peer_endpoint'], msg: 'field required', type: 'value_error.missing' },
      { loc: ['body', 'persistent_keepalive'], msg: 'value is not a valid integer', type: 'type_error.integer' },
    ]);
    expect(result.message).toBe(
      'peer_endpoint: field required; persistent_keepalive: value is not a valid integer',
    );
    expect(result.fieldErrors).toEqual([
      { field: 'peer_endpoint', message: 'field required' },
      { field: 'persistent_keepalive', message: 'value is not a valid integer' },
    ]);
  });

  it('strips the leading body/query/path loc segment', () => {
    const result = formatDetail([{ loc: ['query', 'limit'], msg: 'ensure this value is <= 500' }]);
    expect(result.fieldErrors?.[0].field).toBe('limit');
  });

  it('falls back to "request" when no field segment remains', () => {
    const result = formatDetail([{ loc: ['body'], msg: 'invalid' }]);
    expect(result.fieldErrors?.[0].field).toBe('request');
  });

  it('returns {} for an empty array or non-array/undefined', () => {
    expect(formatDetail([])).toEqual({});
    expect(formatDetail(undefined)).toEqual({});
    expect(formatDetail(42)).toEqual({});
  });

  it('uses a default message when msg is missing', () => {
    const result = formatDetail([{ loc: ['body', 'x'] }]);
    expect(result.fieldErrors?.[0].message).toBe('Invalid value');
  });
});
