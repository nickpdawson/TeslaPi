import { Card } from '../common/Card';
import type { SystemStatus } from '../../api/types';

interface SystemCardProps {
  system: SystemStatus;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function getTempColor(temp: number): string {
  if (temp >= 75) return 'var(--color-error)';
  if (temp >= 60) return 'var(--color-warning)';
  return 'var(--color-success)';
}

function getWifiLabel(signal: number): string {
  const abs = Math.abs(signal);
  if (abs <= 50) return 'Excellent';
  if (abs <= 60) return 'Good';
  if (abs <= 70) return 'Fair';
  return 'Weak';
}

function getWifiColor(signal: number): string {
  const abs = Math.abs(signal);
  if (abs <= 50) return 'var(--color-success)';
  if (abs <= 60) return 'var(--color-success)';
  if (abs <= 70) return 'var(--color-warning)';
  return 'var(--color-error)';
}

function SystemIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}

function TempGauge({ temp }: { temp: number }) {
  const color = getTempColor(temp);
  // Map temp 30-85 to angle 0-180
  const clampedTemp = Math.max(30, Math.min(85, temp));
  const angle = ((clampedTemp - 30) / 55) * 180;

  return (
    <div style={{
      position: 'relative',
      width: '80px',
      height: '44px',
      overflow: 'hidden',
    }}>
      {/* Background arc */}
      <svg width="80" height="44" viewBox="0 0 80 44" style={{ position: 'absolute', top: 0, left: 0 }}>
        <path
          d="M 8 40 A 32 32 0 0 1 72 40"
          fill="none"
          stroke="var(--color-border)"
          stroke-width="6"
          stroke-linecap="round"
        />
        <path
          d="M 8 40 A 32 32 0 0 1 72 40"
          fill="none"
          stroke={color}
          stroke-width="6"
          stroke-linecap="round"
          stroke-dasharray={`${(angle / 180) * 100.5} 100.5`}
          style={{ transition: 'stroke-dasharray 0.6s ease, stroke 0.3s ease' }}
        />
      </svg>
      {/* Center label */}
      <div style={{
        position: 'absolute',
        bottom: '2px',
        left: 0,
        right: 0,
        textAlign: 'center',
        fontSize: 'var(--text-sm)',
        fontWeight: 'var(--font-weight-bold)',
        fontFamily: 'var(--font-mono)',
        color,
      }}>
        {temp.toFixed(0)}&deg;
      </div>
    </div>
  );
}

export function SystemCard({ system }: SystemCardProps) {
  const expandContent = (
    <div style={{ fontSize: 'var(--text-sm)' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: 'var(--space-2) 0',
        color: 'var(--color-text-secondary)',
      }}>
        <span>Hostname</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{system.hostname}</span>
      </div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: 'var(--space-2) 0',
        color: 'var(--color-text-secondary)',
        borderTop: '1px solid var(--color-border)',
      }}>
        <span>IP Address</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{system.ipAddress}</span>
      </div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: 'var(--space-2) 0',
        color: 'var(--color-text-secondary)',
        borderTop: '1px solid var(--color-border)',
      }}>
        <span>CPU Usage</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{system.cpuUsage}%</span>
      </div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: 'var(--space-2) 0',
        color: 'var(--color-text-secondary)',
        borderTop: '1px solid var(--color-border)',
      }}>
        <span>Memory</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {formatBytes(system.memoryUsed)} / {formatBytes(system.memoryTotal)}
        </span>
      </div>
    </div>
  );

  return (
    <Card
      title="System"
      icon={<SystemIcon />}
      expandable
      expandContent={expandContent}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-around' }}>
        {/* Temperature Gauge */}
        <div style={{ textAlign: 'center', padding: 'var(--space-2) var(--space-3)' }}>
          <TempGauge temp={system.cpuTemp} />
          <div style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--color-text-muted)',
            marginTop: 'var(--space-1)',
          }}>
            CPU Temp
          </div>
        </div>

        {/* RAM */}
        <div style={{ textAlign: 'center', padding: 'var(--space-2) var(--space-3)' }}>
          <div style={{
            fontSize: 'var(--text-xl)',
            fontWeight: 'var(--font-weight-bold)',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text)',
          }}>
            {Math.round((system.memoryUsed / system.memoryTotal) * 100)}%
          </div>
          <div style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--color-text-muted)',
            marginTop: 'var(--space-1)',
          }}>
            RAM
          </div>
        </div>

        {/* WiFi */}
        <div style={{ textAlign: 'center', padding: 'var(--space-2) var(--space-3)' }}>
          <div style={{
            fontSize: 'var(--text-xl)',
            fontWeight: 'var(--font-weight-bold)',
            fontFamily: 'var(--font-mono)',
            color: getWifiColor(system.wifiSignal),
          }}>
            {system.wifiSignal}
          </div>
          <div style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--color-text-muted)',
            marginTop: 'var(--space-1)',
          }}>
            WiFi ({getWifiLabel(system.wifiSignal)})
          </div>
        </div>

        {/* Uptime */}
        <div style={{ textAlign: 'center', padding: 'var(--space-2) var(--space-3)' }}>
          <div style={{
            fontSize: 'var(--text-lg)',
            fontWeight: 'var(--font-weight-bold)',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text)',
          }}>
            {system.uptime}
          </div>
          <div style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--color-text-muted)',
            marginTop: 'var(--space-1)',
          }}>
            Uptime
          </div>
        </div>
      </div>
    </Card>
  );
}
