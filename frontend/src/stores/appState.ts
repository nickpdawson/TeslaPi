import { signal, computed } from '@preact/signals';
import { get } from '../api/client';
import type { TeslaPiStatus } from '../api/types';

// --- Setup State ---
// null = not yet checked, true = complete, false = needs setup
export const setupComplete = signal<boolean | null>(null);
export const setupDetectedConfig = signal<Record<string, string> | null>(null);

export async function checkSetupStatus(): Promise<void> {
  try {
    const result = await get<{
      setupComplete: boolean;
      hasExistingConfig: boolean;
      detectedConfig: Record<string, string> | null;
    }>('/setup/status');
    setupComplete.value = result.setupComplete;
    if (result.detectedConfig) {
      setupDetectedConfig.value = result.detectedConfig;
    }
  } catch {
    // If the endpoint fails, assume setup is complete (don't block the app)
    setupComplete.value = true;
  }
}

// Kick off setup check immediately
checkSetupStatus();

// --- Theme ---
type Theme = 'dark' | 'light';

function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem('teslapi-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage unavailable
  }
  return 'dark';
}

export const theme = signal<Theme>(getInitialTheme());

export function toggleTheme(): void {
  const next = theme.value === 'dark' ? 'light' : 'dark';
  theme.value = next;
  try {
    localStorage.setItem('teslapi-theme', next);
  } catch {
    // ignore
  }
  document.documentElement.setAttribute('data-theme', next);
}

// Apply initial theme to DOM
document.documentElement.setAttribute('data-theme', theme.value);

// --- Status ---
export const status = signal<TeslaPiStatus | null>(null);
export const connected = signal<boolean>(false);

// --- Notifications ---
export interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  timestamp: number;
}

export const notifications = signal<Notification[]>([]);

let notificationCounter = 0;

export function addNotification(
  type: Notification['type'],
  message: string,
): string {
  const id = `notif-${++notificationCounter}-${Date.now()}`;
  const notification: Notification = {
    id,
    type,
    message,
    timestamp: Date.now(),
  };
  notifications.value = [...notifications.value, notification];

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    removeNotification(id);
  }, 5000);

  return id;
}

export function removeNotification(id: string): void {
  notifications.value = notifications.value.filter(n => n.id !== id);
}

// --- Derived State ---
export const isLoading = computed(() => status.value === null);
export const systemStatus = computed(() => status.value?.system ?? null);
export const storageInfo = computed(() => status.value?.storage ?? []);
export const archiveStatus = computed(() => status.value?.archive ?? null);
export const musicStatus = computed(() => status.value?.music ?? null);
export const dashcamEvents = computed(() => status.value?.dashcamEvents ?? []);
