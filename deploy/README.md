# TeslaPi Deployment Guide

## Architecture

```
Raspberry Pi 4 Model B
+-----------------------------------------------------------+
|  SD Card (root filesystem - read-only)                    |
|  +-----------------------------------------------------+  |
|  | /var/www/teslapi/    Frontend (Preact SPA)           |  |
|  | /opt/teslapi/        Backend (FastAPI + venv)        |  |
|  | /etc/nginx/          Nginx reverse proxy (:80)       |  |
|  | /etc/systemd/        teslapi.service                 |  |
|  +-----------------------------------------------------+  |
|                                                           |
|  /mutable/ partition (writable)                           |
|  +-----------------------------------------------------+  |
|  | /mutable/teslapi/    DB, state, drives.json          |  |
|  +-----------------------------------------------------+  |
|                                                           |
|  External USB Drive (/dev/sda)                            |
|  +-----------------------------------------------------+  |
|  | /backingfiles/       Disk images (cam, music, etc.)  |  |
|  | /mnt/cam/            Mounted cam disk image          |  |
|  | /mnt/music/          Mounted music disk image        |  |
|  +-----------------------------------------------------+  |
|                                                           |
|  USB Gadget (/dev/gadget) --> Tesla Vehicle               |
+-----------------------------------------------------------+

Request flow:
  Browser --> :80 Nginx --> /api/* --> :8080 FastAPI (uvicorn)
                        --> /*     --> /var/www/teslapi/ (SPA)
                        --> /TeslaCam/* --> /mnt/cam/TeslaCam/
```

## Prerequisites

- Raspberry Pi 4 Model B (2GB+ RAM)
- MicroSD card (32GB+ recommended) with Raspberry Pi OS Lite (Bookworm)
- External USB drive for backing files
- teslausb already set up (or setting up fresh)
- On your dev machine: Node.js 18+, npm, bash

## Quick Deploy (from dev machine)

If you have an existing teslausb Pi on your network:

```bash
./deploy/deploy-to-pi.sh <pi-ip-or-hostname>
# Example:
./deploy/deploy-to-pi.sh 192.168.1.50
# With a non-root user:
./deploy/deploy-to-pi.sh 192.168.1.50 pi
```

This builds the frontend, packages everything, uploads to the Pi, and runs the
installer. The Pi's root filesystem is temporarily remounted read-write during
installation, then returned to read-only.

## Manual Deploy

### 1. Build on your dev machine

```bash
cd /path/to/TeslaPi
bash deploy/build.sh
```

This produces `dist/teslapi.tar.gz`.

### 2. Copy to Pi

```bash
scp dist/teslapi.tar.gz root@<pi-ip>:/tmp/
```

### 3. Install on Pi

```bash
ssh root@<pi-ip>
cd /tmp
tar xzf teslapi.tar.gz
bash teslapi/install.sh
```

## Fresh Install on a New SD Card

### Flash the SD card (macOS)

1. Download Raspberry Pi OS Lite (64-bit, Bookworm) from
   https://www.raspberrypi.com/software/operating-systems/

2. Insert the SD card and identify the disk:
   ```bash
   diskutil list
   # Look for the SD card - e.g., /dev/disk12
   ```

3. Unmount and flash:
   ```bash
   diskutil unmountDisk /dev/disk12
   sudo dd bs=1m if=raspios-bookworm-arm64-lite.img of=/dev/rdisk12 status=progress
   ```
   Note: Use `/dev/rdisk12` (raw disk) for faster writes.

4. Enable SSH on first boot:
   ```bash
   touch /Volumes/bootfs/ssh
   ```

5. Eject and boot the Pi:
   ```bash
   diskutil eject /dev/disk12
   ```

### Set up teslausb

Follow the standard teslausb setup at https://github.com/marcone/teslausb

During setup, the `configure-web.sh` script runs. To use TeslaPi instead of
the default web UI, replace the script before running setup:

```bash
# On the Pi, after cloning teslausb but before running setup:
cp /path/to/TeslaPi/deploy/configure-web.sh /root/bin/configure-web.sh
```

Or set the `TESLAPI_RELEASE_URL` environment variable in your
`teslausb_setup_variables.conf` to point to your release tarball.

### Install TeslaPi on top of existing teslausb

If teslausb is already set up, just run the quick deploy or manual deploy
steps above. The installer handles everything including nginx config migration.

## Updating an Existing Installation

Same as deploying -- the installer is idempotent:

```bash
./deploy/deploy-to-pi.sh <pi-ip>
```

Or manually:
```bash
bash deploy/build.sh
scp dist/teslapi.tar.gz root@<pi-ip>:/tmp/
ssh root@<pi-ip> 'cd /tmp && tar xzf teslapi.tar.gz && bash teslapi/install.sh'
```

The installer will:
- Remount root rw temporarily
- Update the venv dependencies
- Replace backend and frontend files
- Restart services
- Remount root ro

No data is lost -- the database and state live on `/mutable/teslapi/` which
persists across updates.

## Troubleshooting

### Backend not starting
```bash
# Check service status and logs
systemctl status teslapi
journalctl -u teslapi -n 50 --no-pager

# Test backend directly
/opt/teslapi/venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8080
```

### Nginx errors
```bash
# Test config syntax
nginx -t

# Check nginx logs
tail -50 /var/log/nginx/error.log

# Verify sites-enabled symlink
ls -la /etc/nginx/sites-enabled/
```

### Frontend not loading (blank page)
```bash
# Check that frontend files exist
ls /var/www/teslapi/
# Should contain index.html and assets/

# Check nginx is serving correctly
curl -s http://localhost/ | head -5
```

### Cannot write to database
```bash
# Ensure /mutable is mounted and writable
mount | grep mutable
ls -la /mutable/teslapi/

# If /mutable doesn't exist or isn't mounted, check fstab
cat /etc/fstab | grep mutable
```

### Root filesystem is read-only (can't install)
```bash
# The installer handles this automatically, but manually:
mount -o remount,rw /
# ... do your work ...
mount -o remount,ro /
```

### Pi not reachable after install
The installer does not change network settings. If the Pi was reachable before,
it should still be reachable. Check:
```bash
# From your dev machine
ping <pi-ip>
# If that works but HTTP doesn't:
ssh root@<pi-ip> 'systemctl status nginx; systemctl status teslapi'
```

## File Layout on Pi

| Path | Contents | Writable? |
|------|----------|-----------|
| `/var/www/teslapi/` | Frontend static files (index.html, assets/) | No (root fs) |
| `/opt/teslapi/backend/` | Python backend source | No (root fs) |
| `/opt/teslapi/venv/` | Python virtual environment | No (root fs) |
| `/opt/teslapi/VERSION` | Build version info | No (root fs) |
| `/etc/systemd/system/teslapi.service` | Systemd unit | No (root fs) |
| `/etc/nginx/sites-available/teslapi` | Nginx config | No (root fs) |
| `/mutable/teslapi/teslapi.db` | SQLite database | Yes |
| `/mutable/teslapi/drives.json` | Drive configuration | Yes |
| `/backingfiles/` | USB disk images | Yes (ext USB) |
| `/mnt/cam/` | Mounted cam image | Yes (loopback) |
| `/mnt/music/` | Mounted music image | Yes (loopback) |
| `/boot/firmware/teslausb_setup_variables.conf` | teslausb config | Yes (boot partition) |
