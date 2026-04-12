#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/dist"

echo "=== TeslaPi Build ==="
echo "Building from: $PROJECT_DIR"

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/teslapi"

# Build frontend
echo "--- Building frontend ---"
cd "$PROJECT_DIR/frontend"
npm ci --production=false
npm run build
# Frontend builds to ../dist/frontend/ via vite config

# Copy frontend to package
cp -r "$BUILD_DIR/frontend" "$BUILD_DIR/teslapi/www"

# Copy backend
echo "--- Packaging backend ---"
cp -r "$PROJECT_DIR/backend" "$BUILD_DIR/teslapi/backend"

# Copy deployment configs
cp "$PROJECT_DIR/deploy/teslapi.nginx" "$BUILD_DIR/teslapi/"
cp "$PROJECT_DIR/deploy/teslapi.service" "$BUILD_DIR/teslapi/"
cp "$PROJECT_DIR/deploy/install.sh" "$BUILD_DIR/teslapi/"
cp "$PROJECT_DIR/deploy/update.sh" "$BUILD_DIR/teslapi/"
cp "$PROJECT_DIR/deploy/rollback.sh" "$BUILD_DIR/teslapi/"
cp "$PROJECT_DIR/deploy/setup-teslapi.sh" "$BUILD_DIR/teslapi/"
cp "$PROJECT_DIR/deploy/teslapi-gadget-enable.sh" "$BUILD_DIR/teslapi/"
cp "$PROJECT_DIR/deploy/teslapi-gadget-disable.sh" "$BUILD_DIR/teslapi/"
cp "$PROJECT_DIR/pyproject.toml" "$BUILD_DIR/teslapi/"

# Create version file
echo "$(date -u +%Y%m%d-%H%M%S)" > "$BUILD_DIR/teslapi/VERSION"
if command -v git &>/dev/null && [ -d "$PROJECT_DIR/.git" ]; then
    git -C "$PROJECT_DIR" rev-parse --short HEAD >> "$BUILD_DIR/teslapi/VERSION"
fi

# Create tarball
echo "--- Creating archive ---"
cd "$BUILD_DIR"
tar czf teslapi.tar.gz teslapi/

echo ""
echo "=== Build Complete ==="
echo "Package: $BUILD_DIR/teslapi.tar.gz"
echo "Size: $(du -h "$BUILD_DIR/teslapi.tar.gz" | cut -f1)"
echo ""
echo "Deploy to Pi:"
echo "  scp $BUILD_DIR/teslapi.tar.gz pi@<pi-ip>:/tmp/"
echo "  ssh pi@<pi-ip> 'cd /tmp && tar xzf teslapi.tar.gz && sudo bash teslapi/install.sh'"
