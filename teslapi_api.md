# TeslaPi API Reference

Complete API reference for building a Home Assistant custom component or any other integration against TeslaPi.

## Overview

| Property | Value |
|----------|-------|
| **Base URL** | `http://<pi-ip>:80/api/` (nginx proxy to FastAPI on :8080) |
| **Authentication** | None (local network only, no tokens required) |
| **Content-Type** | `application/json` for all request and response bodies |
| **Timestamps** | ISO 8601 UTC (e.g. `2026-04-09T14:34:00+00:00`) |
| **Error format** | `{"detail": "error message"}` with appropriate HTTP status code |

All endpoints are prefixed with `/api/`. For example, the health check is `GET /api/health`.

---

## Endpoints

### Health Check

#### `GET /api/health`

Lightweight health probe. Always returns quickly.

**Response** `200 OK`
```json
{
  "status": "ok",
  "version": "0.1.0",
  "dev_mode": false
}
```

---

### System Status (Primary Polling Endpoint)

#### `GET /api/status`

Returns the full system status in a single call. This is the **primary endpoint for HA polling** -- it contains system info, storage, gadget state, archive status, music status, and recent dashcam events.

**Response** `200 OK`
```json
{
  "state": "idle",
  "system": {
    "hostname": "teslapi",
    "os_version": "Raspberry Pi OS 12 (bookworm)",
    "teslausb_version": "2024.44.25",
    "uptime_seconds": 59721,
    "cpu_temp_celsius": 38.2,
    "ram_used_bytes": 432013312,
    "ram_total_bytes": 4147483648,
    "wifi_ssid": "HomeWiFi",
    "wifi_signal_dbm": -42,
    "ip_address": "192.168.1.50"
  },
  "storage": [
    {
      "total_bytes": 150323855360,
      "used_bytes": 112742891520,
      "free_bytes": 37580963840,
      "percent_used": 75.0,
      "mount_point": "/mnt/cam",
      "label": "Dashcam"
    },
    {
      "total_bytes": 1932735283200,
      "used_bytes": 1759218604032,
      "free_bytes": 173516679168,
      "percent_used": 91.0,
      "mount_point": "/mnt/music",
      "label": "Music"
    },
    {
      "total_bytes": 1073741824,
      "used_bytes": 0,
      "free_bytes": 1073741824,
      "percent_used": 0.0,
      "mount_point": "/mnt/lightshow",
      "label": "Lightshow"
    },
    {
      "total_bytes": 1073741824,
      "used_bytes": 0,
      "free_bytes": 1073741824,
      "percent_used": 0.0,
      "mount_point": "/mnt/boombox",
      "label": "Boombox"
    }
  ],
  "gadget": {
    "enabled": true,
    "state": "active",
    "drives": ["cam", "music", "lightshow", "boombox"]
  },
  "dashcam": [
    {
      "timestamp": "2026-04-09T14:34:00+00:00",
      "type": "sentry",
      "path": "/TeslaCam/SentryClips/2026-04-09_14-34-00/front.mp4",
      "size_bytes": 524288000,
      "camera": "front"
    }
  ],
  "archive": {
    "server_reachable": true,
    "server_name": "your-nas.local",
    "last_archive_at": "2026-04-09T06:00:00+00:00",
    "last_archive_clips": 47,
    "last_archive_bytes": 13207024640,
    "next_archive": ""
  },
  "music": {
    "total_artists": 12,
    "total_tracks": 156,
    "last_sync_at": "2026-04-08T03:00:00+00:00",
    "sync_in_progress": false,
    "current_job_id": null
  },
  "timestamp": "2026-04-09T20:15:00+00:00"
}
```

**`state` values:** `idle`, `connected`, `archiving`, `syncing`, `error`, `offline`

**Notes:**
- Storage entries may show `used_bytes: 0` when the drive is presented to the Tesla via USB gadget and cannot be mounted simultaneously.
- When the gadget is active, storage totals come from the backing file size.
- `dashcam` events are pulled from the archived clips database (not live from the cam image).
- Poll this endpoint every 30 seconds for HA sensor updates.

---

### System Info

#### `GET /api/system/info`

Detailed system information.

**Response** `200 OK`
```json
{
  "hostname": "teslapi",
  "os_version": "Raspberry Pi OS 12 (bookworm)",
  "teslausb_version": "2024.44.25",
  "uptime": "4 days, 0:00",
  "uptime_seconds": 345600,
  "timestamp": "2026-04-09T20:15:00+00:00"
}
```

---

#### `POST /api/system/reboot`

Reboot the Raspberry Pi. Requires confirmation.

**Request body:**
```json
{
  "confirm": true
}
```

**Response** `200 OK`
```json
{
  "status": "ok",
  "message": "System is rebooting"
}
```

**Status codes:**
- `400` if `confirm` is not `true`
- `500` if reboot command fails

---

### Dashcam Archive

#### `POST /api/archive/start`

Trigger a new dashcam archive job. Mounts the cam image read-only, discovers unarchived clips, copies them to the network share via rsync, and records results in the database.

**Request body:**
```json
{
  "trigger": "manual",
  "delete_after": false
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `trigger` | string | `"manual"` | `"manual"` or `"ha"` (for HA-triggered) |
| `delete_after` | bool | `false` | Delete clips from cam after successful archive |

**Response** `200 OK`
```json
{
  "job_id": 42
}
```

**Status codes:**
- `409` if an archive is already in progress

---

#### `GET /api/archive/status`

Get the latest archive job status and aggregate statistics.

**Response** `200 OK`
```json
{
  "latest_job": {
    "id": 42,
    "status": "completed",
    "trigger": "manual",
    "clips_total": 47,
    "clips_copied": 47,
    "bytes_total": 13207024640,
    "bytes_copied": 13207024640,
    "clips_deleted": 0,
    "error_message": null,
    "started_at": "2026-04-09T06:00:00",
    "completed_at": "2026-04-09T06:12:34",
    "created_at": "2026-04-09T06:00:00"
  },
  "total_clips": 312,
  "total_bytes": 87539319808,
  "server_name": "your-nas.local",
  "server_reachable": true
}
```

**`latest_job.status` values:** `pending`, `running`, `completed`, `failed`, `cancelled`

**Notes:**
- When `status` is `running`, poll this endpoint to track progress (`clips_copied / clips_total`).
- `total_clips` and `total_bytes` are cumulative across all jobs.
- `server_reachable` is a live ping check to the archive server.

---

#### `DELETE /api/archive`

Cancel the currently running archive job.

**Response** `200 OK`
```json
{
  "cancelled": true
}
```

**Status codes:**
- `404` if no archive is in progress

---

#### `GET /api/archive/history`

Get past archive jobs.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 20 | Number of jobs to return (1-100) |

**Response** `200 OK`
```json
[
  {
    "id": 42,
    "status": "completed",
    "trigger": "auto",
    "clips_total": 47,
    "clips_copied": 47,
    "bytes_total": 13207024640,
    "bytes_copied": 13207024640,
    "clips_deleted": 0,
    "error_message": null,
    "started_at": "2026-04-09T06:00:00",
    "completed_at": "2026-04-09T06:12:34",
    "created_at": "2026-04-09T06:00:00"
  }
]
```

---

#### `GET /api/archive/clips`

Get individual archived clips with pagination.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `event_type` | string | null | Filter: `"SavedClips"` or `"SentryClips"` |
| `offset` | int | 0 | Pagination offset |
| `limit` | int | 50 | Results per page (1-200) |

**Response** `200 OK`
```json
{
  "clips": [
    {
      "id": 1,
      "event_type": "SentryClips",
      "event_dir": "2026-04-09_14-34-00",
      "clip_file": "2026-04-09_14-34-front.mp4",
      "size_bytes": 52428800,
      "archived_at": "2026-04-09T06:05:12",
      "archive_job_id": 42,
      "deleted_from_cam": false
    }
  ],
  "total": 312,
  "offset": 0,
  "limit": 50,
  "hasMore": true
}
```

---

### Music Sync

#### `POST /api/music/sync`

Start a music sync job. Disables the USB gadget, mounts images, rsyncs selected content, then re-enables the gadget.

**Request body:**
```json
{
  "mode": "selected",
  "paths": ["/Amy Winehouse", "/Dire Straits/Brothers in Arms"],
  "count": 20,
  "type": "artist"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | `"selected"` | `"selected"`, `"random"`, `"recent"`, or `"full"` |
| `paths` | string[] | `[]` | Paths to sync (for `selected` mode) |
| `count` | int | 20 | Number of items (for `random`/`recent` modes) |
| `type` | string | `"artist"` | Item type for random: `"artist"` or `"album"` |

**Response** `200 OK`
```json
{
  "job_id": 5,
  "status": "pending",
  "paths_count": 2
}
```

**Status codes:**
- `400` if no paths specified for `selected` mode
- `409` if a sync is already in progress

**Important:** Music sync temporarily disconnects all USB drives from the Tesla. Only trigger when the car is parked.

---

#### `POST /api/music/sync/full`

Start a full library sync (copies everything from remote to local).

**Response** `200 OK`
```json
{
  "job_id": 6,
  "status": "pending",
  "mode": "full"
}
```

---

#### `GET /api/music/sync/status`

Get current/latest sync job status.

**Response** `200 OK`
```json
{
  "status": "running",
  "job": {
    "id": 5,
    "status": "running",
    "mode": "selective",
    "paths_json": "[\"/Amy Winehouse\"]",
    "files_total": 150,
    "files_copied": 73,
    "bytes_total": 5000000000,
    "bytes_copied": 2400000000,
    "error_message": null,
    "started_at": "2026-04-09T20:00:00",
    "completed_at": null,
    "created_at": "2026-04-09T20:00:00"
  }
}
```

**Notes:**
- When `status` is `running`, track progress via `files_copied / files_total`.
- When no sync has ever run: `{"status": "idle", "job": null}`

---

#### `DELETE /api/music/sync`

Cancel the active sync job. Kills the rsync process, unmounts images, and re-enables the USB gadget.

**Response** `200 OK`
```json
{
  "message": "Sync cancellation requested"
}
```

**Status codes:**
- `404` if no active sync to cancel

---

#### `GET /api/music/sync/history`

Get past sync jobs.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 20 | Number of jobs (1-100) |

**Response** `200 OK`
```json
{
  "jobs": [...],
  "count": 5
}
```

---

#### `POST /api/music/sync/new`

Sync only files newer than the last completed sync. Falls back to full sync if no previous sync exists.

**Response** `200 OK`
```json
{
  "job_id": 7,
  "status": "pending",
  "mode": "new",
  "paths_count": 12
}
```

---

#### `GET /api/music/local`

Scan the local music drive image and return what is currently on the Tesla's USB drive.

**Response** `200 OK`
```json
{
  "artists": [
    {
      "name": "Amy Winehouse",
      "albums": [
        {
          "name": "Back to Black",
          "tracks": [
            {"name": "Rehab.flac", "size": 22000000}
          ],
          "track_count": 5,
          "total_size": 109000000
        }
      ],
      "total_tracks": 9,
      "total_size": 189000000
    }
  ],
  "total_size": 630500000,
  "total_tracks": 24
}
```

**Notes:**
- This endpoint briefly mounts the music image read-only if not already mounted.
- May be slow on first call (disk I/O to walk the filesystem).

---

#### `GET /api/music/library/browse`

Browse the remote music share directory tree.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | `"/"` | Directory path to browse |
| `offset` | int | 0 | Pagination offset |
| `limit` | int | 200 | Items per page (1-500) |
| `filter` | string | `""` | Filename filter |

**Response** `200 OK`
```json
{
  "items": [
    {
      "name": "Amy Winehouse",
      "path": "/Amy Winehouse",
      "isDirectory": true,
      "size": 0,
      "modified": 1712678400,
      "type": "directory"
    }
  ],
  "total": 847,
  "offset": 0,
  "limit": 200,
  "hasMore": true,
  "path": "/"
}
```

**Notes:**
- Automatically mounts the remote music share on demand (idle timeout: 5 minutes).
- `503` if music share is not configured.

---

#### `GET /api/music/library/stats`

Library index statistics.

**Response** `200 OK`
```json
{
  "total_artists": 847,
  "total_albums": 2341,
  "total_tracks": 12483,
  "total_size": 450000000000
}
```

---

#### `GET /api/music/library/artists`

Paginated artist list from the indexed library.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 50 | Results per page (1-500) |
| `offset` | int | 0 | Pagination offset |
| `search` | string | `""` | Filter artists by name |

---

#### `GET /api/music/library/artists/{artist}/albums`

Albums for a specific artist.

**Response** `200 OK`
```json
{
  "artist": "Amy Winehouse",
  "albums": [
    {"album": "Back to Black", "track_count": 11, "total_size": 450000000},
    {"album": "Frank", "track_count": 13, "total_size": 380000000}
  ]
}
```

---

#### `GET /api/music/library/search`

Full-text search across all indexed music fields.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | (required) | Search query (min 1 char) |
| `limit` | int | 50 | Max results (1-200) |

**Response** `200 OK`
```json
{
  "query": "winehouse",
  "results": [...],
  "count": 24
}
```

---

#### `GET /api/music/library/random`

Random artists or albums from the index.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `count` | int | 20 | Number of items (1-100) |
| `type` | string | `"artist"` | `"artist"` or `"album"` |

---

#### `GET /api/music/library/recent`

Most recently modified items.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `count` | int | 50 | Number of items (1-200) |

---

#### `POST /api/music/library/index`

Trigger re-indexing of the remote music library. Mounts the share and scans all files.

**Response** `200 OK`
```json
{
  "message": "Indexing started",
  "status": "indexing"
}
```

**Status codes:**
- `409` if indexing is already in progress

---

#### `GET /api/music/library/index/status`

Get current indexing progress.

**Response** `200 OK`
```json
{
  "active": true,
  "total_files": 12483,
  "indexed_files": 5234,
  "started_at": 1712678400,
  "completed_at": null,
  "error": null
}
```

---

#### `POST /api/music/local/delete`

Delete content from the local music drive.

**Request body:**
```json
{
  "path": "Music/Amy Winehouse"
}
```

**Response** `200 OK`
```json
{
  "message": "Deleted Music/Amy Winehouse",
  "deleted": true
}
```

**Notes:**
- Temporarily disables the USB gadget, mounts the image R/W, deletes, unmounts, and re-enables the gadget.

---

### USB Gadget

#### `GET /api/gadget/status`

Get USB mass storage gadget state.

**Response** `200 OK`
```json
{
  "enabled": true,
  "state": "active",
  "drives": ["cam", "music", "lightshow", "boombox"]
}
```

**`state` values:** `active`, `disabled`, `unknown`

---

#### `POST /api/gadget/toggle`

Enable or disable the USB gadget. Enabling presents all configured disk images to the Tesla as USB mass storage.

**Request body:**
```json
{
  "enabled": true
}
```

**Response** `200 OK` (returns updated `GadgetStatus`)
```json
{
  "enabled": true,
  "state": "active",
  "drives": ["cam", "music", "lightshow", "boombox"]
}
```

---

#### `GET /api/gadget/drives`

List configured USB gadget drives with sizes.

**Response** `200 OK`
```json
[
  {"name": "cam", "path": "/mnt/cam", "size_bytes": 150323855360, "type": "dashcam"},
  {"name": "music", "path": "/mnt/music", "size_bytes": 1932735283200, "type": "music"},
  {"name": "lightshow", "path": "/mnt/lightshow", "size_bytes": 1073741824, "type": "lightshow"},
  {"name": "boombox", "path": "/mnt/boombox", "size_bytes": 1073741824, "type": "boombox"}
]
```

---

### Network

#### `GET /api/network/status`

Combined WiFi and WireGuard status.

**Response** `200 OK`
```json
{
  "wifi": {
    "connected": true,
    "ssid": "HomeWiFi",
    "signal": 78,
    "ip_address": "192.168.1.50",
    "gateway": "192.168.1.1",
    "dns": ["192.168.1.1"],
    "mac_address": "dc:a6:32:xx:xx:xx",
    "frequency": "5 GHz",
    "is_home_network": true
  },
  "wireguard": {
    "installed": true,
    "configured": true,
    "active": false,
    "interface": "wg-teslapi",
    "address": "192.168.7.3/32",
    "peer_endpoint": "203.0.113.1:51820",
    "last_handshake": "2026-04-09T19:45:00",
    "transfer_rx": 1234567,
    "transfer_tx": 7654321,
    "allowed_ips": "10.0.0.0/16, 172.16.0.0/16",
    "auto_connect": true,
    "only_non_home": true,
    "home_ssid": "HomeWiFi"
  }
}
```

---

#### `GET /api/network/wifi/connections`

List saved WiFi connection profiles.

**Response** `200 OK`
```json
[
  {
    "ssid": "HomeWiFi",
    "uuid": "abc-123",
    "priority": 100,
    "auto_connect": true,
    "active": true,
    "device": "wlan0",
    "signal": 78,
    "ip_address": "192.168.1.50"
  }
]
```

---

#### `GET /api/network/wifi/scan`

Scan for available WiFi networks.

**Response** `200 OK`
```json
[
  {
    "ssid": "HomeWiFi",
    "signal": 78,
    "security": "WPA2",
    "frequency": "5 GHz",
    "in_use": true
  }
]
```

---

#### `POST /api/network/wifi/add`

Add a new WiFi connection.

**Request body:**
```json
{
  "ssid": "MyNetwork",
  "password": "secret",
  "priority": 50,
  "hidden": false,
  "auto_connect": true
}
```

---

#### `DELETE /api/network/wifi/{ssid}`

Remove a saved WiFi connection.

---

#### `PUT /api/network/wifi/{ssid}/priority`

Update autoconnect priority.

**Request body:**
```json
{
  "priority": 100
}
```

---

#### `POST /api/network/wifi/{ssid}/connect`

Manually connect to a saved network.

---

#### `POST /api/network/wifi/disconnect`

Disconnect from the current WiFi network.

---

#### `GET /api/network/wireguard/status`

Get WireGuard tunnel status. (See `GET /api/network/status` for the same data in the combined response.)

---

#### `PUT /api/network/wireguard/config`

Save WireGuard tunnel configuration.

**Request body:**
```json
{
  "private_key": "base64...",
  "address": "192.168.7.3/32",
  "dns": "192.168.1.1",
  "peer_public_key": "base64...",
  "peer_endpoint": "203.0.113.1:51820",
  "allowed_ips": "10.0.0.0/16, 172.16.0.0/16",
  "persistent_keepalive": 25
}
```

---

#### `GET /api/network/wireguard/config`

Get current WireGuard config (private key masked).

---

#### `POST /api/network/wireguard/enable`

Bring up the WireGuard tunnel.

---

#### `POST /api/network/wireguard/disable`

Bring down the WireGuard tunnel.

---

#### `POST /api/network/wireguard/auto`

Configure WireGuard auto-connect behaviour.

**Request body:**
```json
{
  "enabled": true,
  "only_non_home": true,
  "home_ssid": "HomeWiFi"
}
```

---

#### `POST /api/network/wireguard/generate-keys`

Generate a new WireGuard keypair.

**Response** `200 OK`
```json
{
  "private_key": "base64...",
  "public_key": "base64..."
}
```

---

#### `POST /api/network/wireguard/test`

Ping through the WireGuard tunnel to test connectivity.

---

### Auto-Sync

#### `GET /api/auto-sync/status`

Get auto-sync background service status.

**Response** `200 OK`
```json
{
  "enabled": true,
  "check_interval": 300,
  "running": true,
  "last_check_at": "2026-04-09T20:10:00+00:00",
  "last_action": "started archive job 43",
  "last_action_at": "2026-04-09T20:10:01+00:00"
}
```

**Notes:**
- `running` indicates whether the background loop is active (always true after startup).
- `enabled` controls whether the loop actually triggers archives.
- Auto-sync only archives dashcam clips; it does NOT auto-sync music (too resource-intensive).
- Archives are only triggered when the archive server is reachable (i.e., Pi is on home WiFi or VPN is up).

---

#### `PUT /api/auto-sync/config`

Enable/disable auto-sync or change the check interval.

**Request body:**
```json
{
  "enabled": true,
  "check_interval": 600
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | bool | No | Enable or disable |
| `check_interval` | int | No | Seconds between checks (min 60, max 86400) |

**Response** `200 OK` (returns updated status, same as `GET /api/auto-sync/status`)

---

### Configuration

#### `GET /api/config`

Get current TeslaPi configuration (sensitive values masked).

**Response** `200 OK`
```json
{
  "config": {
    "ARCHIVE_SERVER": "your-nas.local",
    "SHARE_NAME": "Tesla/dashcam",
    "SHARE_USER": "teslapi",
    "SHARE_PASSWORD": "********",
    "cam_size": "150G",
    "music_size": "1800G"
  },
  "keys": 12
}
```

---

#### `PUT /api/config`

Update configuration values. Preserves file format and comments.

**Request body:**
```json
{
  "updates": {
    "ARCHIVE_SERVER": "newserver.example.com",
    "cam_size": "200G"
  }
}
```

**Response** `200 OK`
```json
{
  "config": {"...": "..."},
  "keys": 12,
  "updated": ["ARCHIVE_SERVER", "cam_size"]
}
```

---

### Updates

#### `GET /api/updates/check`

Check GitHub releases for a newer TeslaPi version.

**Response** `200 OK`
```json
{
  "available": true,
  "current_version": "0.1.0",
  "latest_version": "0.2.0",
  "changelog": "## What's New\n- Auto-sync service\n- Dashboard fixes",
  "download_url": "https://github.com/.../releases/download/v0.2.0/teslapi-0.2.0.tar.gz",
  "published_at": "2026-04-09T12:00:00Z",
  "size_bytes": 5242880
}
```

---

#### `GET /api/updates/current-version`

Get the installed version.

**Response** `200 OK`
```json
{
  "version": "0.1.0"
}
```

---

#### `POST /api/updates/download-and-apply`

Download and apply the latest release.

**Status codes:**
- `409` if an update is already in progress

---

#### `POST /api/updates/upload`

Upload a `.tar.gz` update archive manually.

**Content-Type:** `multipart/form-data`
**Field:** `file` (the tarball)

---

#### `POST /api/updates/rollback`

Roll back to the previous version.

---

#### `GET /api/updates/history`

Get past update records.

**Response** `200 OK`
```json
[
  {
    "version": "0.1.0",
    "from_version": "0.0.9",
    "timestamp": "2026-04-01T10:00:00",
    "success": true,
    "method": "github",
    "message": "Updated successfully"
  }
]
```

---

#### `GET /api/updates/status`

Status of an in-progress update.

**Response** `200 OK`
```json
{
  "in_progress": true,
  "stage": "downloading",
  "progress": 0.45,
  "message": "Downloading update..."
}
```

---

#### `PUT /api/updates/auto-check`

Configure automatic update checking.

**Request body:**
```json
{
  "enabled": true,
  "interval_hours": 24
}
```

---

### Diagnostics

#### `GET /api/diagnostics`

Run system diagnostics.

**Response** `200 OK`
```json
{
  "status": "ok",
  "checks": {
    "storage": {"status": "ok", "details": "All mounts healthy"},
    "network": {"status": "ok", "details": "WiFi connected, archive server reachable"},
    "gadget": {"status": "ok", "details": "USB gadget active with 4 drives"},
    "temperature": {"status": "ok", "details": "CPU: 38.2C"}
  }
}
```

---

### WebSocket: Live Logs

#### `WS /api/ws/logs/{logname}`

Stream log file contents in real-time via WebSocket.

**Supported log names:** `syslog`, `teslausb`, `archive`, `kern`, `dmesg`

**Protocol:** Standard WebSocket. Server sends text frames with log lines. Starts with the last 50 lines, then streams new lines as they appear (tail -F).

**Example (JavaScript):**
```javascript
const ws = new WebSocket('ws://192.168.1.50/api/ws/logs/archive');
ws.onmessage = (e) => console.log(e.data);
```

---

## Suggested Home Assistant Entities

### Sensors

| Entity ID | Source | Description |
|-----------|--------|-------------|
| `sensor.teslapi_status` | `GET /api/status` -> `state` | Overall state: idle/archiving/syncing |
| `sensor.teslapi_cpu_temp` | `status.system.cpu_temp_celsius` | CPU temperature in Celsius |
| `sensor.teslapi_cam_storage_pct` | `status.storage[label=Dashcam].percent_used` | Cam drive usage percentage |
| `sensor.teslapi_music_storage_pct` | `status.storage[label=Music].percent_used` | Music drive usage percentage |
| `sensor.teslapi_last_archive` | `status.archive.last_archive_at` | Timestamp of last archive |
| `sensor.teslapi_last_music_sync` | `status.music.last_sync_at` | Timestamp of last music sync |
| `sensor.teslapi_clips_archived` | `GET /api/archive/status` -> `total_clips` | Total clips archived (lifetime) |
| `sensor.teslapi_artists_synced` | `status.music.total_artists` | Artists synced to Tesla |
| `sensor.teslapi_wifi_signal` | `status.system.wifi_signal_dbm` | WiFi signal strength in dBm |
| `sensor.teslapi_uptime` | `status.system.uptime_seconds` | Uptime in seconds (use HA template for formatting) |

### Binary Sensors

| Entity ID | Source | Description |
|-----------|--------|-------------|
| `binary_sensor.teslapi_online` | `GET /api/health` succeeds | Pi is reachable |
| `binary_sensor.teslapi_gadget_active` | `status.gadget.enabled` | USB gadget is presenting drives |
| `binary_sensor.teslapi_archive_running` | `status.state == "archiving"` | Archive job in progress |
| `binary_sensor.teslapi_music_syncing` | `status.music.sync_in_progress` | Music sync in progress |
| `binary_sensor.teslapi_server_reachable` | `status.archive.server_reachable` | Archive server is reachable |
| `binary_sensor.teslapi_auto_sync_enabled` | `GET /api/auto-sync/status` -> `enabled` | Auto-sync is enabled |

### Buttons (Services)

| Entity ID | API Call | Description |
|-----------|----------|-------------|
| `button.teslapi_archive_now` | `POST /api/archive/start {"trigger": "ha"}` | Trigger dashcam archive |
| `button.teslapi_sync_music` | `POST /api/music/sync {"mode": "full"}` | Trigger full music sync |
| `button.teslapi_reboot` | `POST /api/system/reboot {"confirm": true}` | Reboot the Pi |

### Camera

| Entity ID | Description |
|-----------|-------------|
| `camera.teslapi_last_dashcam` | Latest front camera thumbnail (future: not yet implemented) |

---

## Example Flows

### Poll Status Every 30 Seconds

```python
# In HA custom component coordinator
async def _async_update_data(self):
    """Fetch data from TeslaPi."""
    async with aiohttp.ClientSession() as session:
        async with session.get(f"http://{self.host}/api/status") as resp:
            data = await resp.json()
    return data
```

Parse the response to update all sensors from a single API call.

### Trigger Archive from HA Automation

```yaml
automation:
  - alias: "Archive dashcam when home"
    trigger:
      - platform: state
        entity_id: device_tracker.tesla_model_3
        to: "home"
        for: "00:05:00"
    action:
      - service: rest_command.teslapi_archive
        data: {}
      # The archive runs asynchronously; poll status to track progress

rest_command:
  teslapi_archive:
    url: "http://192.168.1.50/api/archive/start"
    method: POST
    content_type: "application/json"
    payload: '{"trigger": "ha"}'
```

### Sync Specific Artist

```yaml
rest_command:
  teslapi_sync_artist:
    url: "http://192.168.1.50/api/music/sync"
    method: POST
    content_type: "application/json"
    payload: '{"mode": "selected", "paths": ["{{ artist }}"]}'
```

Then poll `GET /api/music/sync/status` until `status` is `completed`.

### Monitor Archive Progress in HA Template Sensor

```yaml
sensor:
  - platform: rest
    resource: "http://192.168.1.50/api/archive/status"
    name: "TeslaPi Archive Progress"
    value_template: >
      {% if value_json.latest_job and value_json.latest_job.status == 'running' %}
        {{ (value_json.latest_job.clips_copied / value_json.latest_job.clips_total * 100) | round(0) }}%
      {% else %}
        {{ value_json.latest_job.status if value_json.latest_job else 'idle' }}
      {% endif %}
    scan_interval: 10
```
