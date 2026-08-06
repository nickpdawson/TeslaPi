export interface SystemStatus {
  uptime: string;
  cpuTemp: number;
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  wifiSignal: number;
  ipAddress: string;
  hostname: string;
}

export interface StorageInfo {
  drive: string; // 'cam' | 'music' | 'lightshow' | 'boombox' | 'external'
  label: string;
  usedBytes: number;
  totalBytes: number;
  mountpoint: string;
  filesystem: string;
  healthy: boolean;
}

export interface GadgetStatus {
  enabled: boolean;
  drives: string[]; // which LUNs are active
}

export interface DashcamEvent {
  id: string;
  type: 'sentry' | 'saved' | 'recent' | 'track';
  timestamp: string;
  cameras: string[]; // available angles
  thumbnailUrl?: string;
  archived: boolean;
}

export interface ArchiveStatus {
  serverReachable: boolean;
  serverName: string;
  lastArchiveTime: string | null;
  lastArchiveClips: number;
  lastArchiveSize: number;
  nextAction: string; // 'waiting for idle', 'archiving', 'syncing'
  status: 'idle' | 'archiving' | 'error' | 'unreachable';
}

export interface MusicSyncStatus {
  artistsSynced: number;
  lastSyncTime: string | null;
  status: 'idle' | 'syncing' | 'error' | 'indexing';
  progress?: {
    filesCopied: number;
    filesTotal: number;
    bytesCopied: number;
    bytesTotal: number;
  };
}

export type SystemState = 'connected' | 'archiving' | 'syncing' | 'idle' | 'error' | 'offline';

export interface TeslaPiStatus {
  // The backend's overall assessment; the dashboard hero reflects this rather than
  // re-deriving health from a single sub-status.
  state: SystemState;
  system: SystemStatus;
  storage: StorageInfo[];
  gadget: GadgetStatus;
  archive: ArchiveStatus;
  music: MusicSyncStatus;
  dashcamEvents: DashcamEvent[];
}

// --- Settings / Configuration types ---

export interface ShareConfig {
  type: 'cifs' | 'nfs';
  server: string;
  path: string;
  username?: string;
  password?: string;
  domain?: string;
  mountOptions?: string;
}

export interface ArchiveConfig {
  system: 'cifs' | 'nfs' | 'rsync' | 'rclone' | 'none';
  share?: ShareConfig;
  rsyncServer?: string;
  rcloneConfig?: string;
}

export interface WiFiConfig {
  ssid: string;
  password?: string;
  country: string;
}

export interface DriveConfig {
  name: string;
  size: string;
  enabled: boolean;
  filesystem: 'ext4' | 'exfat';
}

export interface HAConfig {
  enabled: boolean;
  url: string;
  token: string;
  mqttBroker?: string;
  mqttPort?: number;
  mqttUsername?: string;
  mqttPassword?: string;
}

export interface NotificationChannelConfig {
  id: string;
  type: 'email' | 'telegram' | 'discord' | 'slack' | 'matrix' | 'ha' | 'pushover' | 'gotify';
  enabled: boolean;
  config: Record<string, string>;
}

export interface TeslaPiConfig {
  hostname: string;
  timezone: string;
  wifi: WiFiConfig;
  archive: ArchiveConfig;
  musicShare?: ShareConfig;
  drives: DriveConfig[];
  dataDrive: string;
  ha?: HAConfig;
  notifications: NotificationChannelConfig[];
}

// --- File Manager types ---

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  type?: string; // mime type hint
}

export interface FileListResponse {
  path: string;
  drive: string;
  entries: FileEntry[];
  parent: string | null;
}

// --- Dashcam Viewer types ---

export interface DashcamClip {
  timestamp: string;
  cameras: Record<string, string>; // camera_name -> video_url
  duration?: number;
}

export interface DashcamEventDetail {
  id: string;
  type: 'sentry' | 'saved' | 'recent' | 'track';
  timestamp: string;
  clips: DashcamClip[];
  totalDuration: number;
  archived: boolean;
}

export type CameraAngle = 'front' | 'left_repeater' | 'right_repeater' | 'left_pillar' | 'right_pillar' | 'back';

export type ViewerLayout = 'grid-2x3' | 'grid-3x2' | 'front-focus' | 'single' | 'side-by-side' | 'picture-in-picture';

// --- Music Library types ---

export interface MusicArtist {
  artist: string;
  track_count: number;
  album_count: number;
  total_size: number;
}

export interface MusicAlbum {
  album: string;
  track_count: number;
  total_size: number;
}

export interface MusicTrack {
  id: number;
  path: string;
  filename: string;
  size_bytes: number;
  synced: boolean;
}

export interface MusicSearchResult {
  artist: string;
  album: string;
  tracks: MusicTrack[];
  total_size: number;
}

export interface MusicLibraryStats {
  total_artists: number;
  total_albums: number;
  total_tracks: number;
  total_size: number;
}

export interface MusicSyncJob {
  id: number;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  mode: string;
  paths_json: string;
  files_total: number;
  files_copied: number;
  bytes_total: number;
  bytes_copied: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface MusicIndexingStatus {
  active: boolean;
  total_files: number;
  indexed_files: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
}

export interface MusicBrowseItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: number;
  type: string;
}

export interface MusicBrowseResponse {
  items: MusicBrowseItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  path: string;
}

export interface MusicRandomItem {
  artist: string;
  album?: string;
  track_count: number;
  album_count?: number;
  total_size: number;
}

export interface MusicRecentItem {
  artist: string;
  album: string;
  track_count: number;
  total_size: number;
  latest_modified: number;
}

export type MusicSyncMode = 'selected' | 'random' | 'recent' | 'full';

export type MusicPageMode = 'browse' | 'search' | 'random' | 'recent';

export type MusicPageTab = 'on-tesla' | 'library';

// --- Local music types (on-Tesla content) ---

export interface LocalMusicTrack {
  name: string;
  size: number;
}

export interface LocalMusicAlbum {
  name: string;
  tracks: LocalMusicTrack[];
  track_count: number;
  total_size: number;
}

export interface LocalMusicArtist {
  name: string;
  albums: LocalMusicAlbum[];
  total_tracks: number;
  total_size: number;
}

export interface LocalMusicData {
  artists: LocalMusicArtist[];
  total_size: number;
  total_tracks: number;
  // Real capacity of the music image (its FAT filesystem total), from the backend.
  // Omitted/0 when the image couldn't be read (e.g. a sync owns it).
  capacity_bytes?: number;
  // Set by the backend when a sync owns the image and the on-Tesla tree can't be
  // read; the UI shows a "syncing" state instead of a misleading empty library.
  syncing?: boolean;
}

// --- Network / WiFi / WireGuard types ---

export interface WiFiNetwork {
  ssid: string;
  signal: number;
  security: string;
  frequency: string;
  inUse: boolean;
}

export interface WiFiConnection {
  ssid: string;
  uuid: string;
  priority: number;
  autoConnect: boolean;
  active: boolean;
  device: string | null;
  signal: number | null;
  ipAddress: string | null;
}

export interface NetworkStatus {
  connected: boolean;
  ssid: string | null;
  signal: number | null;
  ipAddress: string | null;
  gateway: string | null;
  dns: string[];
  macAddress: string | null;
  frequency: string | null;
  isHomeNetwork: boolean;
}

export interface WireGuardConfig {
  privateKey: string;
  address: string;
  dns: string | null;
  peerPublicKey: string;
  peerEndpoint: string;
  allowedIps: string;
  persistentKeepalive: number;
  // True when the user just generated keys and wants the new one applied.
  // Omitted/false on an edit, so the active tunnel key is preserved.
  useGeneratedKey?: boolean;
}

export interface WireGuardStatus {
  installed: boolean;
  configured: boolean;
  active: boolean;
  interface: string;
  address: string | null;
  peerEndpoint: string | null;
  lastHandshake: string | null;
  transferRx: number | null;
  transferTx: number | null;
  allowedIps: string | null;
  autoConnect: boolean;
  onlyNonHome: boolean;
  homeSsid: string | null;
}

// --- Setup Wizard types ---

export interface SetupStatus {
  setupComplete: boolean;
  hasExistingConfig: boolean;
  detectedConfig: Record<string, string> | null;
}

export interface SetupDetectResponse {
  existingConfig: Record<string, string>;
  hardware: {
    drives: SetupDetectedDrive[];
    wifiInterfaces: string[];
    hostname: string;
  };
}

export interface SetupDetectedDrive {
  device: string;
  size: string;
  model: string;
}

export interface SetupValidateResponse {
  valid: boolean;
  errors: Record<string, string>;
  message: string;
}

export interface SetupCompleteResponse {
  success: boolean;
  message: string;
  configKeysWritten: number;
  provisioningStarted?: boolean;
}

export interface SetupProvisionProgress {
  running: boolean;
  step: number;
  totalSteps: number;
  stepName?: string;
  currentAction: string;
  progress: number;
  overallProgress: number;
  error: string | null;
}

export interface SetupHardwareStatus {
  driveDetected: boolean;
  driveDevice: string | null;
  driveSize: string | null;
  drivePartitioned: boolean;
  mutableMounted: boolean;
  backingfilesMounted: boolean;
  camImageExists: boolean;
  musicImageExists: boolean;
  lightshowImageExists: boolean;
  boomboxImageExists: boolean;
  gadgetConfigured: boolean;
  gadgetKernelModule: boolean;
  archiveLoopInstalled: boolean;
  setupComplete: boolean;
}

// --- OTA Update types ---

export interface UpdateInfo {
  available: boolean;
  // Explicit outcome so "up to date" is only claimed when the check truly succeeded:
  // 'update_available' | 'up_to_date' | 'no_releases' | 'error'. May be absent on
  // older responses (treat as up_to_date/update_available per `available`).
  status?: 'update_available' | 'up_to_date' | 'no_releases' | 'error';
  error?: string | null;
  current_version: string;
  latest_version: string | null;
  changelog: string | null;
  download_url: string | null;
  published_at: string | null;
  size_bytes: number | null;
}

export interface UpdateResult {
  success: boolean;
  from_version: string;
  to_version: string;
  message: string;
  rolled_back: boolean;
  timestamp: string;
}

export interface UpdateStatus {
  in_progress: boolean;
  stage: string | null;
  progress: number;
  message: string | null;
}

export interface UpdateRecord {
  version: string;
  from_version: string;
  timestamp: string;
  success: boolean;
  method: string;
  message: string;
}

export interface AutoUpdateConfig {
  enabled: boolean;
  interval_hours: number;
  last_check: string | null;
  update_available?: boolean;
  latest_version?: string | null;
}

// --- Lock Chime / Customization types ---

export interface LockChimeStatus {
  installed: boolean;
  filename: string | null;
  size: number;
}

export interface ArchiveJob {
  id: number;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  trigger: string;
  clipsTotal: number;
  clipsCopied: number;
  bytesTotal: number;
  bytesCopied: number;
  clipsDeleted: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ArchiveFullStatus {
  status: string;
  job: ArchiveJob | null;
  stats: {
    totalClipsArchived: number;
    totalBytesArchived: number;
    serverReachable: boolean;
    serverName: string;
  };
}
