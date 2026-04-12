#!/usr/bin/env bash
# TeslaPi Installer — runs on Raspberry Pi 4 B
# Usage: sudo bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[TeslaPi]${NC} $*"; }
warn()  { echo -e "${YELLOW}[TeslaPi]${NC} $*"; }
error() { echo -e "${RED}[TeslaPi]${NC} $*" >&2; }

# Must be root
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root (sudo bash install.sh)"
    exit 1
fi

# Detect Pi model
PI_MODEL=$(cat /proc/device-tree/model 2>/dev/null || echo "Unknown")
log "Installing TeslaPi on: $PI_MODEL"

# Check for Pi 4
if [[ "$PI_MODEL" != *"Raspberry Pi 4"* ]]; then
    warn "This is optimized for Raspberry Pi 4 B. Detected: $PI_MODEL"
    warn "Continuing anyway..."
fi

# Remount root filesystem as read-write if needed
ROOT_RO=false
if mount | grep 'on / ' | grep -q 'ro,\|ro)'; then
    log "Root filesystem is read-only, remounting read-write..."
    mount -o remount,rw /
    ROOT_RO=true
fi

# Trap to remount ro on exit if we changed it
cleanup() {
    if $ROOT_RO; then
        log "Remounting root filesystem as read-only..."
        mount -o remount,ro / 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Install required system packages
log "Installing system dependencies..."
apt-get update -qq 2>/dev/null || warn "apt-get update failed (may be offline)"
PACKAGES=(nginx python3-venv cifs-utils nfs-common wireguard-tools exfatprogs dosfstools parted gdisk)
# Install packages one at a time so a single missing package doesn't abort everything
for pkg in "${PACKAGES[@]}"; do
    if ! dpkg -s "$pkg" &>/dev/null; then
        log "Installing $pkg..."
        apt-get install -y -qq "$pkg" 2>/dev/null || warn "Failed to install $pkg (may not be available)"
    fi
done

# Create directories
log "Creating directories..."
mkdir -p /opt/teslapi
mkdir -p /var/www/teslapi

# Use /mutable/teslapi if available, fall back to /var/lib/teslapi
if mountpoint -q /mutable 2>/dev/null || [[ -d /mutable ]]; then
    mkdir -p /mutable/teslapi
else
    warn "/mutable not mounted yet — using /var/lib/teslapi as fallback"
    mkdir -p /var/lib/teslapi
    # Create a symlink so paths still resolve
    if [[ ! -e /mutable/teslapi ]]; then
        mkdir -p /mutable
        ln -sf /var/lib/teslapi /mutable/teslapi
    fi
fi

# Install/update Python virtual environment
if [[ ! -d /opt/teslapi/venv ]]; then
    log "Creating Python virtual environment..."
    python3 -m venv /opt/teslapi/venv
fi

log "Installing Python dependencies..."
/opt/teslapi/venv/bin/pip install --quiet --upgrade pip
/opt/teslapi/venv/bin/pip install --quiet \
    "fastapi>=0.115.0" \
    "uvicorn[standard]>=0.32.0" \
    "aiosqlite>=0.20.0" \
    "pydantic>=2.9.0" \
    "pydantic-settings>=2.6.0" \
    "python-multipart>=0.0.12" \
    "websockets>=13.0" \
    "httpx>=0.28.0"

# Copy backend
log "Installing backend..."
rm -rf /opt/teslapi/backend
cp -r "$SCRIPT_DIR/backend" /opt/teslapi/backend
cp "$SCRIPT_DIR/pyproject.toml" /opt/teslapi/

# Copy frontend
log "Installing frontend..."
rm -rf /var/www/teslapi/*
cp -r "$SCRIPT_DIR/www/"* /var/www/teslapi/

# Copy version file
cp "$SCRIPT_DIR/VERSION" /opt/teslapi/VERSION

# Copy deploy scripts (setup-teslapi.sh and gadget scripts needed for provisioning)
log "Installing deploy scripts..."
mkdir -p /opt/teslapi/deploy
for deploy_script in setup-teslapi.sh teslapi-gadget-enable.sh teslapi-gadget-disable.sh; do
    if [[ -f "$SCRIPT_DIR/$deploy_script" ]]; then
        cp "$SCRIPT_DIR/$deploy_script" /opt/teslapi/deploy/
        chmod +x "/opt/teslapi/deploy/$deploy_script"
    fi
done

# Install nginx config
log "Configuring nginx..."
NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"

# Back up existing config
if [[ -f "$NGINX_AVAILABLE/teslausb" ]] && [[ ! -f "$NGINX_AVAILABLE/teslausb.bak" ]]; then
    cp "$NGINX_AVAILABLE/teslausb" "$NGINX_AVAILABLE/teslausb.bak"
    log "Backed up existing teslausb nginx config"
fi

cp "$SCRIPT_DIR/teslapi.nginx" "$NGINX_AVAILABLE/teslapi"
# Remove old symlinks, create new one
for old_site in default teslausb; do
    rm -f "$NGINX_ENABLED/$old_site" 2>/dev/null || true
done
ln -sf "$NGINX_AVAILABLE/teslapi" "$NGINX_ENABLED/teslapi"

# Test nginx config
if nginx -t 2>/dev/null; then
    log "Nginx config is valid"
else
    error "Nginx config test failed!"
    # Restore backup if available
    if [[ -f "$NGINX_AVAILABLE/teslausb.bak" ]]; then
        cp "$NGINX_AVAILABLE/teslausb.bak" "$NGINX_AVAILABLE/teslapi"
        error "Restored previous config"
    fi
    exit 1
fi

# Install systemd service
log "Installing systemd service..."
cp "$SCRIPT_DIR/teslapi.service" /etc/systemd/system/teslapi.service
systemctl daemon-reload

# Enable and start services
log "Starting services..."
systemctl enable teslapi.service
systemctl restart teslapi.service
systemctl restart nginx

# Wait for backend to be ready
log "Waiting for backend..."
for i in $(seq 1 10); do
    if curl -sf http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
        log "Backend is healthy!"
        break
    fi
    if [[ $i -eq 10 ]]; then
        warn "Backend not responding yet. Check: journalctl -u teslapi"
    fi
    sleep 1
done

# Print status
log ""
log "========================================="
log "  TeslaPi installed successfully!"
log "========================================="
log ""
log "  Web UI:  http://$(hostname -I | awk '{print $1}')"
log "  API:     http://$(hostname -I | awk '{print $1}')/api/health"
log "  Logs:    journalctl -u teslapi -f"
log ""
log "  Version: $(cat /opt/teslapi/VERSION | head -1)"
log ""

# Show migration hint
if [[ -f /boot/firmware/teslausb_setup_variables.conf ]]; then
    log "  Existing teslausb config detected!"
    log "  Open the web UI to review and manage your settings."
fi
