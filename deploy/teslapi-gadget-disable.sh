#!/bin/bash
# TeslaPi USB Gadget Disable
# Safely tears down the USB gadget configfs entries and optionally unloads modules.
#
# CRITICAL SAFETY CONTRACT: this script MUST exit non-zero if the gadget is still
# bound to a UDC when it returns. The music/dashcam sync paths call this before
# mounting a backing image read-write; if the car still binds the drive (UDC not
# cleared) while the host mounts it RW, two writers share one FAT filesystem and it
# corrupts. The caller treats a non-zero exit as "do NOT mount the image".
set -euo pipefail

# Overridable only so the safety logic can be exercised in tests against a fake
# configfs tree; production always uses the real gadget path.
GADGET="${TESLAPI_GADGET_DIR:-/sys/kernel/config/usb_gadget/teslapi}"

if [ ! -d "$GADGET" ]; then
    echo "Gadget not configured, nothing to disable."
    exit 0
fi

# Deactivate the UDC (unbind from the USB controller). This is the step that
# actually disconnects the drives from the car.
echo "" > "$GADGET/UDC" 2>/dev/null || true

# VERIFY the UDC is now empty. A non-empty UDC means the gadget is still live and
# the car can still be writing the drives — fail loudly so the caller aborts rather
# than mounting a backing image the car is actively writing.
bound="$(cat "$GADGET/UDC" 2>/dev/null | tr -d '[:space:]' || true)"
if [ -n "$bound" ]; then
    echo "error: gadget still bound to UDC '$bound' after unbind attempt; refusing to report success" >&2
    exit 1
fi

# Remove function symlinks from config
for f in "$GADGET"/configs/c.1/mass_storage.*; do
    [ -e "$f" ] && rm -f "$f" 2>/dev/null
done

# Remove functions
for f in "$GADGET"/functions/mass_storage.*; do
    if [ -d "$f" ]; then
        rmdir "$f" 2>/dev/null || true
    fi
done

# Remove config strings and config
rmdir "$GADGET/configs/c.1/strings/0x409" 2>/dev/null || true
rmdir "$GADGET/configs/c.1" 2>/dev/null || true

# Remove gadget strings and gadget
rmdir "$GADGET/strings/0x409" 2>/dev/null || true
rmdir "$GADGET" 2>/dev/null || true

echo "USB gadget disabled (UDC confirmed unbound)."
