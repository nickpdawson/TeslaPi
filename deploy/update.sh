#!/bin/bash
# TeslaPi update helper — called by the updater service
# Usage: sudo bash update.sh <tarball_path> <backup_dir>
#
# Exit codes:
#   0 = success
#   1 = failed (no rollback attempted)
#   2 = failed and rolled back
set -euo pipefail

TARBALL="${1:?Usage: update.sh <tarball_path> <backup_dir>}"
BACKUP_DIR="${2:?Usage: update.sh <tarball_path> <backup_dir>}"
EXTRACT_DIR="/tmp/teslapi-update-extract"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[TeslaPi Update]${NC} $*"; }
warn()  { echo -e "${YELLOW}[TeslaPi Update]${NC} $*"; }
error() { echo -e "${RED}[TeslaPi Update]${NC} $*" >&2; }

# Must be root
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root"
    exit 1
fi

# Track whether we changed the rootfs mount state
ROOT_WAS_RO=false
# Match `ro` only as a standalone mount option, not the `ro` in `errors=remount-ro`
# (see install.sh) — the old pattern remounted a normal rw root read-only on exit.
if mount | grep 'on / ' | grep -qE '\(ro[,)]|,ro[,)]'; then
    ROOT_WAS_RO=true
fi

# Cleanup trap — always try to remount ro if we changed it, even on failure
cleanup() {
    local exit_code=$?
    if $ROOT_WAS_RO; then
        log "Remounting root filesystem as read-only..."
        mount -o remount,ro / 2>/dev/null || true
    fi
    # Clean up extraction directory
    rm -rf "$EXTRACT_DIR" 2>/dev/null || true
    exit $exit_code
}
trap cleanup EXIT

# --- Step 1: Backup current installation ---
log "Backing up current installation to $BACKUP_DIR..."
rm -rf "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"

if [[ -d /opt/teslapi/backend ]]; then
    cp -a /opt/teslapi/backend "$BACKUP_DIR/backend"
fi
if [[ -d /var/www/teslapi ]]; then
    cp -a /var/www/teslapi "$BACKUP_DIR/frontend"
fi
if [[ -f /opt/teslapi/VERSION ]]; then
    cp -a /opt/teslapi/VERSION "$BACKUP_DIR/VERSION"
fi
log "Backup complete"

# --- Step 2: Extract tarball ---
log "Extracting update from $TARBALL..."
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
tar xzf "$TARBALL" -C "$EXTRACT_DIR"

# Find install.sh — it may be inside a subdirectory like teslapi/
INSTALL_SH=""
for candidate in "$EXTRACT_DIR"/install.sh "$EXTRACT_DIR"/*/install.sh; do
    if [[ -f "$candidate" ]]; then
        INSTALL_SH="$candidate"
        break
    fi
done

if [[ -z "$INSTALL_SH" ]]; then
    error "install.sh not found in update package"
    exit 1
fi

PKG_DIR="$(dirname "$INSTALL_SH")"
log "Found installer at: $INSTALL_SH"

# --- Step 3: Remount rootfs read-write ---
if $ROOT_WAS_RO; then
    log "Remounting root filesystem as read-write..."
    mount -o remount,rw /
fi

# --- Step 4: Run the installer ---
log "Running installer..."
cd "$PKG_DIR"
if ! bash "$INSTALL_SH"; then
    error "Installer failed — attempting rollback..."
    # Rollback
    if [[ -d "$BACKUP_DIR/backend" ]]; then
        rm -rf /opt/teslapi/backend
        cp -a "$BACKUP_DIR/backend" /opt/teslapi/backend
    fi
    if [[ -d "$BACKUP_DIR/frontend" ]]; then
        rm -rf /var/www/teslapi/*
        cp -a "$BACKUP_DIR/frontend/"* /var/www/teslapi/
    fi
    if [[ -f "$BACKUP_DIR/VERSION" ]]; then
        cp -a "$BACKUP_DIR/VERSION" /opt/teslapi/VERSION
    fi
    error "Rolled back to previous version"
    exit 2
fi

log "Update applied successfully"
# The cleanup trap will handle remounting ro
exit 0
