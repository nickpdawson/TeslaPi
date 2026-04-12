"""Pydantic models matching the frontend TypeScript interfaces."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


# --- Enums ---

class SystemState(str, Enum):
    CONNECTED = "connected"
    ARCHIVING = "archiving"
    SYNCING = "syncing"
    IDLE = "idle"
    ERROR = "error"
    OFFLINE = "offline"


class ShareType(str, Enum):
    CIFS = "cifs"
    NFS = "nfs"


class SyncJobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


# --- Status models ---

class StorageInfo(BaseModel):
    total_bytes: int = 0
    used_bytes: int = 0
    free_bytes: int = 0
    percent_used: float = 0.0
    mount_point: str = ""
    label: str = ""


class GadgetStatus(BaseModel):
    enabled: bool = False
    state: str = "unknown"
    drives: list[str] = Field(default_factory=list)


class DashcamEvent(BaseModel):
    timestamp: datetime | None = None
    type: str = ""
    path: str = ""
    size_bytes: int = 0
    camera: str = ""


class ArchiveStatus(BaseModel):
    server_reachable: bool = False
    server_name: str = ""
    last_archive_at: datetime | None = None
    last_archive_clips: int = 0
    last_archive_bytes: int = 0
    next_archive: str = ""


class MusicSyncStatus(BaseModel):
    total_artists: int = 0
    total_tracks: int = 0
    last_sync_at: datetime | None = None
    sync_in_progress: bool = False
    current_job_id: int | None = None


class SystemStatus(BaseModel):
    hostname: str = ""
    os_version: str = ""
    teslausb_version: str = ""
    uptime_seconds: int = 0
    cpu_temp_celsius: float = 0.0
    ram_used_bytes: int = 0
    ram_total_bytes: int = 0
    wifi_ssid: str = ""
    wifi_signal_dbm: int = 0
    ip_address: str = ""


class TeslaPiStatus(BaseModel):
    """Top-level status response matching the frontend TeslaPiStatus interface."""
    state: SystemState = SystemState.IDLE
    system: SystemStatus = Field(default_factory=SystemStatus)
    storage: list[StorageInfo] = Field(default_factory=list)
    gadget: GadgetStatus = Field(default_factory=GadgetStatus)
    dashcam: list[DashcamEvent] = Field(default_factory=list)
    archive: ArchiveStatus = Field(default_factory=ArchiveStatus)
    music: MusicSyncStatus = Field(default_factory=MusicSyncStatus)
    timestamp: datetime | None = None


# --- Config models ---

class ShareConfig(BaseModel):
    type: ShareType = ShareType.CIFS
    server: str = ""
    path: str = ""
    username: str = ""
    password: str = ""
    domain: str = ""
    mount_options: str = ""


class HAConfig(BaseModel):
    url: str = ""
    token: str = ""
    mqtt_broker: str = ""
    mqtt_port: int = 1883
    mqtt_username: str = ""
    mqtt_password: str = ""
    enabled: bool = False


class NotificationChannel(BaseModel):
    id: str
    enabled: bool = False
    config: dict = Field(default_factory=dict)


class ConfigUpdate(BaseModel):
    """Payload for PUT /api/config."""
    updates: dict[str, str]


# --- API response models ---

class ApiError(BaseModel):
    detail: str
    code: str


class RebootRequest(BaseModel):
    confirm: bool = False


class GadgetToggleRequest(BaseModel):
    enabled: bool


class DriveInfo(BaseModel):
    name: str
    path: str
    size_bytes: int = 0
    type: str = ""


class LockChimeStatus(BaseModel):
    installed: bool = False
    filename: str | None = None
    size: int = 0


# --- WiFi models ---


class WiFiNetwork(BaseModel):
    """A WiFi network visible in a scan."""
    ssid: str
    signal: int  # 0-100 percentage
    security: str  # "WPA2", "WPA3", "Open", etc.
    frequency: str  # "2.4 GHz", "5 GHz"
    in_use: bool = False


class WiFiConnection(BaseModel):
    """A saved WiFi connection profile managed by NetworkManager."""
    ssid: str
    uuid: str
    priority: int
    auto_connect: bool
    active: bool
    device: str | None = None
    signal: int | None = None
    ip_address: str | None = None


class NetworkStatus(BaseModel):
    """Overall network status for the WiFi interface."""
    connected: bool
    ssid: str | None = None
    signal: int | None = None
    ip_address: str | None = None
    gateway: str | None = None
    dns: list[str] = Field(default_factory=list)
    mac_address: str | None = None
    frequency: str | None = None
    is_home_network: bool = False


class WiFiAddRequest(BaseModel):
    """Request body for adding a new WiFi connection."""
    ssid: str
    password: str
    priority: int = 0
    hidden: bool = False
    auto_connect: bool = True


# --- WireGuard models ---


class WireGuardConfig(BaseModel):
    """WireGuard tunnel configuration."""
    private_key: str
    address: str  # e.g. "192.168.7.3/32"
    dns: str | None = None  # e.g. "192.168.1.1"
    peer_public_key: str
    peer_endpoint: str  # e.g. "203.0.113.1:51820"
    allowed_ips: str  # e.g. "10.0.0.0/16, 172.16.0.0/16"
    persistent_keepalive: int = 25


class WireGuardStatus(BaseModel):
    """WireGuard tunnel runtime status."""
    installed: bool
    configured: bool
    active: bool
    interface: str = "wg-teslapi"
    address: str | None = None
    peer_endpoint: str | None = None
    last_handshake: str | None = None
    transfer_rx: int | None = None  # bytes
    transfer_tx: int | None = None  # bytes
    allowed_ips: str | None = None
    auto_connect: bool = False
    only_non_home: bool = True
    home_ssid: str | None = None


# --- Update models ---


class UpdateInfo(BaseModel):
    """Information about an available update."""
    available: bool
    current_version: str
    latest_version: str | None = None
    changelog: str | None = None
    download_url: str | None = None
    published_at: str | None = None
    size_bytes: int | None = None


class UpdateResult(BaseModel):
    """Result of an update or rollback operation."""
    success: bool
    from_version: str
    to_version: str
    message: str
    rolled_back: bool = False
    timestamp: str


class UpdateRecord(BaseModel):
    """A single entry in the update history log."""
    version: str
    from_version: str
    timestamp: str
    success: bool
    method: str  # "github", "upload", "rollback"
    message: str


class UpdateStatus(BaseModel):
    """Status of an in-progress update operation."""
    in_progress: bool
    stage: str | None = None  # "downloading", "backing_up", "installing", "restarting", "verifying"
    progress: float = 0  # 0-1
    message: str | None = None


class AutoUpdateConfig(BaseModel):
    """Auto-update check configuration."""
    enabled: bool = False
    interval_hours: int = 24
    last_check: str | None = None


# --- Setup / Provisioning models ---


class SetupProgress(BaseModel):
    """Progress of the hardware provisioning setup."""
    running: bool = False
    step: int = 0
    total_steps: int = 13
    step_name: str | None = None
    current_action: str = "Not started"
    progress: float = 0  # 0-1 within current step
    overall_progress: float = 0  # 0-1 total
    error: str | None = None


class HardwareStatus(BaseModel):
    """Current state of TeslaPi hardware configuration."""
    drive_detected: bool = False
    drive_device: str | None = None
    drive_size: str | None = None
    drive_partitioned: bool = False
    mutable_mounted: bool = False
    backingfiles_mounted: bool = False
    cam_image_exists: bool = False
    music_image_exists: bool = False
    lightshow_image_exists: bool = False
    boombox_image_exists: bool = False
    gadget_configured: bool = False
    gadget_kernel_module: bool = False
    archive_loop_installed: bool = False
    setup_complete: bool = False
