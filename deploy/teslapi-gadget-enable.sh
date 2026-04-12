#!/bin/bash
# TeslaPi USB Gadget Enable
# Loads dwc2 and libcomposite dynamically (no boot-time module loading),
# configures USB mass storage gadget via configfs, and activates UDC.
set -euo pipefail

# Load modules (safe if already loaded)
modprobe dwc2 || true
modprobe libcomposite || true

# Ensure configfs is mounted
if ! mountpoint -q /sys/kernel/config 2>/dev/null; then
    mount -t configfs none /sys/kernel/config 2>/dev/null || true
fi

GADGET=/sys/kernel/config/usb_gadget/teslapi

if [ -d "$GADGET" ]; then
    echo "Gadget already configured at $GADGET"
    exit 0
fi

mkdir -p "$GADGET"
cd "$GADGET"

echo 0x1d6b > idVendor    # Linux Foundation
echo 0x0104 > idProduct   # Multifunction Composite Gadget
echo 0x0100 > bcdDevice
echo 0x0200 > bcdUSB

mkdir -p strings/0x409
echo "TeslaPi" > strings/0x409/manufacturer
echo "TeslaPi USB Drive" > strings/0x409/product
# Use Pi serial number or machine-id as serial
if [ -f /proc/cpuinfo ]; then
    SERIAL=$(grep Serial /proc/cpuinfo | cut -d: -f2 | tr -d ' ' || echo "unknown")
else
    SERIAL="unknown"
fi
echo "$SERIAL" > strings/0x409/serialnumber

mkdir -p configs/c.1/strings/0x409
echo "TeslaPi Config" > configs/c.1/strings/0x409/configuration
echo 250 > configs/c.1/MaxPower

# Create mass storage functions for each existing backing file
DRIVE_COUNT=0
for drive in cam music lightshow boombox; do
    img="/backingfiles/${drive}_disk.bin"
    if [ -f "$img" ]; then
        mkdir -p "functions/mass_storage.${drive}"
        echo 1 > "functions/mass_storage.${drive}/stall"
        echo 0 > "functions/mass_storage.${drive}/lun.0/cdrom"
        echo 0 > "functions/mass_storage.${drive}/lun.0/ro"
        echo 0 > "functions/mass_storage.${drive}/lun.0/nofua"
        echo "$img" > "functions/mass_storage.${drive}/lun.0/file"
        ln -sf "functions/mass_storage.${drive}" "configs/c.1/"
        DRIVE_COUNT=$((DRIVE_COUNT + 1))
        echo "  Added $drive ($img)"
    fi
done

if [ "$DRIVE_COUNT" -eq 0 ]; then
    echo "ERROR: No backing files found in /backingfiles/. Cannot enable gadget."
    # Clean up the empty gadget
    rmdir configs/c.1/strings/0x409 2>/dev/null || true
    rmdir configs/c.1 2>/dev/null || true
    rmdir strings/0x409 2>/dev/null || true
    cd /
    rmdir "$GADGET" 2>/dev/null || true
    exit 1
fi

# Activate
UDC=$(ls /sys/class/udc 2>/dev/null | head -1)
if [ -n "$UDC" ]; then
    echo "$UDC" > UDC
    echo "USB gadget enabled with $DRIVE_COUNT drive(s) on UDC $UDC"
else
    echo "WARNING: No UDC found. Gadget configured but not activated."
    echo "This may mean dwc2 is not loaded or the hardware does not support USB gadget mode."
fi
