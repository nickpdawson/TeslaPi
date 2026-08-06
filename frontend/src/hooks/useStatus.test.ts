import { describe, it, expect } from 'vitest';
import { transformStatus } from './useStatus';

describe('transformStatus (snake_case API -> camelCase, iters 25/29)', () => {
  it('maps the backend top-level state (iter 29 — hero used to ignore it)', () => {
    expect(transformStatus({ state: 'syncing' }).state).toBe('syncing');
    expect(transformStatus({ state: 'error' }).state).toBe('error');
  });

  it('defaults state to idle when absent', () => {
    expect(transformStatus({}).state).toBe('idle');
  });

  it('maps cpu fields: cpu_temp_celsius -> cpuTemp, cpu_usage -> cpuUsage (iter 25)', () => {
    const sys = transformStatus({ system: { cpu_temp_celsius: 48.2, cpu_usage: 12.5 } }).system;
    expect(sys.cpuTemp).toBe(48.2);
    expect(sys.cpuUsage).toBe(12.5);
  });

  it('defaults cpuUsage to 0 when the backend omits it', () => {
    expect(transformStatus({ system: {} }).system.cpuUsage).toBe(0);
  });

  it('maps memory/wifi/ip fields and formats uptime', () => {
    const status = transformStatus({
      system: {
        uptime_seconds: 90061, // 1d 1h 1m
        ram_used_bytes: 100,
        ram_total_bytes: 200,
        wifi_signal_dbm: -42,
        ip_address: '10.0.0.9',
        hostname: 'teslapi',
      },
    });
    expect(status.system.memoryUsed).toBe(100);
    expect(status.system.memoryTotal).toBe(200);
    expect(status.system.wifiSignal).toBe(-42);
    expect(status.system.ipAddress).toBe('10.0.0.9');
    expect(status.system.uptime).toBe('1d 1h 1m');
  });

  it('maps storage and archive sub-objects to camelCase', () => {
    const status = transformStatus({
      storage: [{ mount_point: '/mnt/music', label: 'Music', used_bytes: 5, total_bytes: 10 }],
      archive: { server_reachable: true, last_archive_bytes: 999 },
    });
    expect(status.storage[0]).toMatchObject({ usedBytes: 5, totalBytes: 10, label: 'Music' });
    expect(status.archive.serverReachable).toBe(true);
    expect(status.archive.lastArchiveSize).toBe(999);
  });
});
