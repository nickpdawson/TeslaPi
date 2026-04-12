#!/bin/bash
# TeslaPi USB Gadget Disable
# Safely tears down the USB gadget configfs entries and optionally unloads modules.
set -euo pipefail

GADGET=/sys/kernel/config/usb_gadget/teslapi

if [ ! -d "$GADGET" ]; then
    echo "Gadget not configured, nothing to disable."
    exit 0
fi

# Deactivate UDC
echo "" > "$GADGET/UDC" 2>/dev/null || true

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

echo "USB gadget disabled."
