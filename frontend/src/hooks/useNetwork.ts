import { useState, useEffect, useCallback } from 'preact/hooks';
import { get, post, put, del } from '../api/client';
import type {
  NetworkStatus,
  WiFiConnection,
  WiFiNetwork,
  WireGuardStatus,
  WireGuardConfig,
} from '../api/types';

const STATUS_POLL_INTERVAL = 10000;
const SCAN_AUTO_INTERVAL = 30000;

export function useNetwork() {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [connections, setConnections] = useState<WiFiConnection[]>([]);
  const [available, setAvailable] = useState<WiFiNetwork[]>([]);
  const [wgStatus, setWgStatus] = useState<WireGuardStatus | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshWgStatus = useCallback(async () => {
    try {
      const data = await get<Record<string, unknown>>('/network/wireguard/status');
      setWgStatus({
        installed: Boolean(data.installed ?? false),
        configured: Boolean(data.configured ?? false),
        active: Boolean(data.active ?? false),
        interface: String(data.interface ?? 'wg-teslapi'),
        address: (data.address ?? null) as string | null,
        peerEndpoint: (data.peer_endpoint ?? data.peerEndpoint ?? null) as string | null,
        lastHandshake: (data.last_handshake ?? data.lastHandshake ?? null) as string | null,
        transferRx: (data.transfer_rx ?? data.transferRx ?? null) as number | null,
        transferTx: (data.transfer_tx ?? data.transferTx ?? null) as number | null,
        allowedIps: (data.allowed_ips ?? data.allowedIps ?? null) as string | null,
        autoConnect: Boolean(data.auto_connect ?? data.autoConnect ?? false),
        onlyNonHome: Boolean(data.only_non_home ?? data.onlyNonHome ?? true),
        homeSsid: (data.home_ssid ?? data.homeSsid ?? null) as string | null,
      });
    } catch {
      // non-critical
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const raw = await get<Record<string, unknown>>('/network/status');
      // API returns { wifi: {...}, wireguard: {...} } — extract wifi as NetworkStatus
      const wifi = (raw.wifi ?? raw) as Record<string, unknown>;
      const wg = (raw.wireguard ?? null) as Record<string, unknown> | null;

      setStatus({
        connected: Boolean(wifi.connected ?? false),
        ssid: (wifi.ssid ?? null) as string | null,
        signal: wifi.signal != null ? Number(wifi.signal) : null,
        ipAddress: (wifi.ip_address ?? wifi.ipAddress ?? null) as string | null,
        gateway: (wifi.gateway ?? null) as string | null,
        dns: (wifi.dns ?? []) as string[],
        macAddress: (wifi.mac_address ?? wifi.macAddress ?? null) as string | null,
        frequency: (wifi.frequency ?? null) as string | null,
        isHomeNetwork: Boolean(wifi.is_home_network ?? wifi.isHomeNetwork ?? false),
      });

      if (wg) {
        setWgStatus({
          installed: Boolean(wg.installed ?? false),
          configured: Boolean(wg.configured ?? false),
          active: Boolean(wg.active ?? false),
          interface: String(wg.interface ?? 'wg-teslapi'),
          address: (wg.address ?? null) as string | null,
          peerEndpoint: (wg.peer_endpoint ?? wg.peerEndpoint ?? null) as string | null,
          lastHandshake: (wg.last_handshake ?? wg.lastHandshake ?? null) as string | null,
          transferRx: (wg.transfer_rx ?? wg.transferRx ?? null) as number | null,
          transferTx: (wg.transfer_tx ?? wg.transferTx ?? null) as number | null,
          allowedIps: (wg.allowed_ips ?? wg.allowedIps ?? null) as string | null,
          autoConnect: Boolean(wg.auto_connect ?? wg.autoConnect ?? false),
          onlyNonHome: Boolean(wg.only_non_home ?? wg.onlyNonHome ?? true),
          homeSsid: (wg.home_ssid ?? wg.homeSsid ?? null) as string | null,
        });
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch network status');
    }
  }, []);

  const refreshConnections = useCallback(async () => {
    try {
      // Backend returns snake_case (auto_connect / ip_address); map to the camelCase
      // WiFiConnection shape so the in-use marker and IP actually render.
      const data = await get<Record<string, unknown>[]>('/network/wifi/connections');
      setConnections(data.map((c) => ({
        ssid: String(c.ssid ?? ''),
        uuid: String(c.uuid ?? ''),
        priority: Number(c.priority ?? 0),
        autoConnect: Boolean(c.auto_connect ?? c.autoConnect ?? false),
        active: Boolean(c.active ?? false),
        device: (c.device ?? null) as string | null,
        signal: (c.signal ?? null) as number | null,
        ipAddress: (c.ip_address ?? c.ipAddress ?? null) as string | null,
      })));
    } catch {
      // non-critical
    }
  }, []);

  const scanNetworks = useCallback(async () => {
    setScanning(true);
    try {
      const data = await get<Record<string, unknown>[]>('/network/wifi/scan');
      setAvailable(data.map((n) => ({
        ssid: String(n.ssid ?? ''),
        signal: Number(n.signal ?? 0),
        security: String(n.security ?? ''),
        frequency: String(n.frequency ?? ''),
        inUse: Boolean(n.in_use ?? n.inUse ?? false),
      })));
    } catch {
      // scan can fail transiently
    } finally {
      setScanning(false);
    }
  }, []);

  const addWifi = useCallback(async (ssid: string, password: string, priority: number, autoConnect: boolean, hidden: boolean) => {
    // Backend WiFiAddRequest expects snake_case `auto_connect`; sending `autoConnect`
    // was silently ignored (unchecking auto-connect had no effect).
    await post('/network/wifi/add', { ssid, password, priority, hidden, auto_connect: autoConnect });
    await refreshConnections();
    await refreshStatus();
  }, [refreshConnections, refreshStatus]);

  const removeWifi = useCallback(async (ssid: string) => {
    await del(`/network/wifi/${encodeURIComponent(ssid)}`);
    await refreshConnections();
  }, [refreshConnections]);

  const updatePriority = useCallback(async (ssid: string, priority: number) => {
    await put(`/network/wifi/${encodeURIComponent(ssid)}/priority`, { priority });
    await refreshConnections();
  }, [refreshConnections]);

  const connectWifi = useCallback(async (ssid: string) => {
    await post(`/network/wifi/${encodeURIComponent(ssid)}/connect`);
    await refreshStatus();
    await refreshConnections();
  }, [refreshStatus, refreshConnections]);

  const saveWgConfig = useCallback(async (config: WireGuardConfig) => {
    // Backend WireGuardConfig is snake_case; sending camelCase 422'd every save.
    await put('/network/wireguard/config', {
      private_key: config.privateKey,
      address: config.address,
      dns: config.dns,
      peer_public_key: config.peerPublicKey,
      peer_endpoint: config.peerEndpoint,
      allowed_ips: config.allowedIps,
      persistent_keepalive: config.persistentKeepalive,
      use_generated_key: config.useGeneratedKey ?? false,
    });
    await refreshWgStatus();
  }, [refreshWgStatus]);

  const toggleWg = useCallback(async (enable: boolean) => {
    await post(`/network/wireguard/${enable ? 'enable' : 'disable'}`);
    await refreshWgStatus();
  }, [refreshWgStatus]);

  const setWgAuto = useCallback(async (enabled: boolean, onlyNonHome: boolean, homeSsid: string | null) => {
    // Backend AutoConnectRequest is snake_case; camelCase was silently ignored.
    await post('/network/wireguard/auto', {
      enabled,
      only_non_home: onlyNonHome,
      home_ssid: homeSsid ?? '',
    });
    await refreshWgStatus();
  }, [refreshWgStatus]);

  const generateKeys = useCallback(async (): Promise<{ publicKey: string }> => {
    // Backend returns snake_case public_key; reading publicKey gave undefined.
    const result = await post<Record<string, unknown>>('/network/wireguard/generate-keys');
    return { publicKey: String(result.public_key ?? result.publicKey ?? '') };
  }, []);

  const testTunnel = useCallback(async (): Promise<{ success: boolean; message: string }> => {
    // Backend returns {success, message, details}; combine into one message
    // (it carries latency/error text) rather than the nonexistent {latencyMs, error}.
    const r = await post<{ success?: boolean; message?: string; details?: string }>(
      '/network/wireguard/test',
    );
    const message = [r.message, r.details].filter(Boolean).join(' — ') || 'Tunnel test complete';
    return { success: Boolean(r.success), message };
  }, []);

  // Initial load
  useEffect(() => {
    let cancelled = false;

    async function init() {
      await Promise.all([
        refreshStatus(),
        refreshConnections(),
        scanNetworks(),
        refreshWgStatus(),
      ]);
      if (!cancelled) setLoading(false);
    }

    init();
    return () => { cancelled = true; };
  }, [refreshStatus, refreshConnections, scanNetworks, refreshWgStatus]);

  // Poll status
  useEffect(() => {
    const timer = setInterval(() => {
      refreshStatus();
      refreshWgStatus();
    }, STATUS_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refreshStatus, refreshWgStatus]);

  // Auto-scan
  useEffect(() => {
    const timer = setInterval(scanNetworks, SCAN_AUTO_INTERVAL);
    return () => clearInterval(timer);
  }, [scanNetworks]);

  return {
    status,
    connections,
    available,
    wgStatus,
    scanning,
    loading,
    error,
    refreshStatus,
    refreshConnections,
    scanNetworks,
    addWifi,
    removeWifi,
    updatePriority,
    connectWifi,
    refreshWgStatus,
    saveWgConfig,
    toggleWg,
    setWgAuto,
    generateKeys,
    testTunnel,
  };
}
