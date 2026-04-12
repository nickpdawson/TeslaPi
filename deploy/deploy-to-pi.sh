#!/usr/bin/env bash
# Deploy TeslaPi to a Raspberry Pi
# Usage: ./deploy/deploy-to-pi.sh <pi-hostname-or-ip> [ssh-user]
#
# This script builds a tarball locally and transfers it as a single file
# to avoid SCP truncation issues on Google Drive / FUSE filesystems.
set -euo pipefail

PI_HOST="${1:?Usage: $0 <pi-hostname-or-ip> [ssh-user]}"
PI_USER="${2:-root}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== TeslaPi Deploy to $PI_USER@$PI_HOST ==="

# Step 1: Build (creates dist/teslapi.tar.gz)
bash "$SCRIPT_DIR/build.sh"

TARBALL="$PROJECT_DIR/dist/teslapi.tar.gz"

if [[ ! -f "$TARBALL" ]]; then
    echo "ERROR: Build did not produce $TARBALL"
    exit 1
fi

# Step 2: Upload the single tarball
# Using a single tar file avoids SCP truncation issues with Google Drive FUSE
echo "--- Uploading tarball to Pi ---"
scp "$TARBALL" "$PI_USER@$PI_HOST:/tmp/teslapi.tar.gz"

# Step 3: Extract and install on Pi
echo "--- Installing on Pi ---"
ssh "$PI_USER@$PI_HOST" 'set -e; cd /tmp && rm -rf teslapi && tar xzf teslapi.tar.gz && sudo bash teslapi/install.sh'

echo ""
echo "=== Deploy Complete ==="
echo "Open: http://$PI_HOST"
