#!/usr/bin/env bash
# TeslaPi web configuration — replaces teslausb configure-web.sh
# Called during teslausb setup process

log_progress() {
    echo "$( date ) : $*" >> /tmp/setup-progress
}

log_progress "Configuring TeslaPi web UI..."

# Install nginx if not present
if ! command -v nginx &>/dev/null; then
    log_progress "Installing nginx..."
    apt-get -y --force-yes install nginx fcgiwrap
fi

# Stop nginx during config
systemctl stop nginx 2>/dev/null || true

# Check if TeslaPi is pre-installed (from image build)
if [[ -d /opt/teslapi/backend ]] && [[ -d /var/www/teslapi ]]; then
    log_progress "TeslaPi already installed, configuring..."
else
    # Download and install TeslaPi
    log_progress "Downloading TeslaPi..."
    TESLAPI_URL="${TESLAPI_RELEASE_URL:-https://github.com/nickpdawson/TeslaPi/releases/latest/download/teslapi.tar.gz}"
    curl -L -o /tmp/teslapi.tar.gz "$TESLAPI_URL"
    cd /tmp && tar xzf teslapi.tar.gz
    bash /tmp/teslapi/install.sh
fi

# Ensure nginx config is in place. Validate the new config BEFORE committing the
# switch: if teslapi.nginx is invalid, keep/restore the default site so nginx still
# has a working config — the old code removed default first, so a bad config left
# nginx (and the whole UI) down with nothing to serve.
if [[ -f /opt/teslapi/teslapi.nginx ]]; then
    cp /opt/teslapi/teslapi.nginx /etc/nginx/sites-available/teslapi
    ln -sf /etc/nginx/sites-available/teslapi /etc/nginx/sites-enabled/teslapi
    # Drop default (it can conflict on :80) then validate the full config.
    rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
    if ! nginx -t 2>/dev/null; then
        log_progress "ERROR: teslapi nginx config failed validation; restoring default site"
        rm -f /etc/nginx/sites-enabled/teslapi 2>/dev/null || true
        [[ -f /etc/nginx/sites-available/default ]] && \
            ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
    fi
fi

# Configure drives for web access based on teslausb config
source /root/bin/envsetup.sh

has_cam=false
has_music=false
has_lightshow=false
has_boombox=false

[[ -e /backingfiles/cam_disk.bin ]] && has_cam=true
[[ -e /backingfiles/music_disk.bin ]] && has_music=true
[[ -e /backingfiles/lightshow_disk.bin ]] && has_lightshow=true
[[ -e /backingfiles/boombox_disk.bin ]] && has_boombox=true

# Write drive config for TeslaPi backend
mkdir -p /mutable/teslapi
cat > /mutable/teslapi/drives.json <<DRIVESEOF
{
    "cam": $has_cam,
    "music": $has_music,
    "lightshow": $has_lightshow,
    "boombox": $has_boombox
}
DRIVESEOF

systemctl enable nginx
if ! systemctl start nginx; then
    log_progress "ERROR: nginx failed to start — check 'nginx -t' and 'journalctl -u nginx'"
fi
systemctl enable teslapi 2>/dev/null || true
systemctl start teslapi 2>/dev/null || true

log_progress "TeslaPi web UI configured."
log_progress "Done configuring nginx"
