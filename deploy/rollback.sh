#!/bin/bash
# TeslaPi rollback — restore from backup
# Usage: sudo bash rollback.sh [backup_dir]
#
# Exit codes:
#   0 = success
#   1 = failed
set -euo pipefail

BACKUP_DIR="${1:-/mutable/teslapi/rollback}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[TeslaPi Rollback]${NC} $*"; }
warn()  { echo -e "${YELLOW}[TeslaPi Rollback]${NC} $*"; }
error() { echo -e "${RED}[TeslaPi Rollback]${NC} $*" >&2; }

# Must be root
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root"
    exit 1
fi

# Verify backup exists
if [[ ! -d "$BACKUP_DIR" ]]; then
    error "Backup directory not found: $BACKUP_DIR"
    exit 1
fi

# Check that at least one of the expected backup dirs is present
if [[ ! -d "$BACKUP_DIR/backend" ]] && [[ ! -d "$BACKUP_DIR/frontend" ]]; then
    error "Backup directory exists but contains no backend or frontend — aborting"
    exit 1
fi

# Track rootfs mount state
ROOT_WAS_RO=false
if mount | grep 'on / ' | grep -q 'ro,\|ro)'; then
    ROOT_WAS_RO=true
fi

cleanup() {
    if $ROOT_WAS_RO; then
        log "Remounting root filesystem as read-only..."
        mount -o remount,ro / 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Show what we're restoring
if [[ -f "$BACKUP_DIR/VERSION" ]]; then
    ROLLBACK_VERSION=$(head -1 "$BACKUP_DIR/VERSION")
    log "Rolling back to version: $ROLLBACK_VERSION"
else
    log "Rolling back (version unknown)"
fi

if [[ -f /opt/teslapi/VERSION ]]; then
    CURRENT_VERSION=$(head -1 /opt/teslapi/VERSION)
    log "Current version: $CURRENT_VERSION"
fi

# Remount rw if needed
if $ROOT_WAS_RO; then
    log "Remounting root filesystem as read-write..."
    mount -o remount,rw /
fi

# Restore backend
if [[ -d "$BACKUP_DIR/backend" ]]; then
    log "Restoring backend..."
    rm -rf /opt/teslapi/backend
    cp -a "$BACKUP_DIR/backend" /opt/teslapi/backend
fi

# Restore frontend
if [[ -d "$BACKUP_DIR/frontend" ]]; then
    log "Restoring frontend..."
    rm -rf /var/www/teslapi/*
    cp -a "$BACKUP_DIR/frontend/"* /var/www/teslapi/
fi

# Restore VERSION file
if [[ -f "$BACKUP_DIR/VERSION" ]]; then
    cp -a "$BACKUP_DIR/VERSION" /opt/teslapi/VERSION
fi

# Restart services
log "Restarting services..."
systemctl restart teslapi || warn "Failed to restart teslapi service"
systemctl restart nginx || warn "Failed to restart nginx"

# Health check
log "Waiting for backend to come up..."
for i in $(seq 1 10); do
    if curl -sf http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
        log "Backend is healthy!"
        break
    fi
    if [[ $i -eq 10 ]]; then
        warn "Backend not responding after rollback. Check: journalctl -u teslapi"
    fi
    sleep 1
done

log "Rollback complete"
exit 0
