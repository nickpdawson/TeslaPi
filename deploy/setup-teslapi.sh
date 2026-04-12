#!/usr/bin/env bash
# ============================================================================
# TeslaPi Setup — configures USB gadget mode and backing files
#
# Replaces the legacy teslausb setup script with a clean, idempotent setup
# that can be run standalone or triggered from the TeslaPi web UI.
#
# Usage:
#   sudo setup-teslapi.sh [OPTIONS]
#
# Options:
#   --config PATH    Path to config file (default: /boot/firmware/teslausb_setup_variables.conf)
#   --dry-run        Show what would be done without making changes
#   --step N         Resume from step N
#   --help           Show this help
#
# The script writes progress to /mutable/teslapi/setup-progress.json so the
# web UI can display real-time status.
# ============================================================================
set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"
readonly TOTAL_STEPS=13
readonly DEFAULT_CONFIG="/boot/firmware/teslausb_setup_variables.conf"
# Progress/log files: use /tmp during setup (always writable), copy to /mutable at end
readonly PROGRESS_FILE="/tmp/teslapi-setup-progress.json"
readonly LOG_FILE="/tmp/teslapi-setup.log"
readonly COMPLETION_FILE="/mutable/teslapi/setup-complete.json"

# Defaults for backing file sizes
readonly DEFAULT_CAM_SIZE="40G"
readonly DEFAULT_MUSIC_SIZE=""
readonly DEFAULT_LIGHTSHOW_SIZE=""
readonly DEFAULT_BOOMBOX_SIZE=""
readonly DEFAULT_FILESYSTEM="exfat"
readonly DEFAULT_DATA_DRIVE="/dev/sda"
readonly DEFAULT_MUTABLE_SIZE="2G"

# Gadget identity
readonly GADGET_VENDOR="0x1d6b"   # Linux Foundation
readonly GADGET_PRODUCT="0x0104"  # Composite Gadget
readonly GADGET_BCD_DEVICE="0x0100"
readonly GADGET_BCD_USB="0x0200"
readonly GADGET_MANUFACTURER="TeslaPi"
readonly GADGET_PRODUCT_NAME="TeslaPi USB Drive"

# Parse arguments
CONFIG_PATH="$DEFAULT_CONFIG"
DRY_RUN=false
START_STEP=1
SHOW_HELP=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --config)
            CONFIG_PATH="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --step)
            START_STEP="$2"
            shift 2
            ;;
        --help)
            SHOW_HELP=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

if $SHOW_HELP; then
    sed -n '2,/^# ====/p' "$0" | head -n -1 | sed 's/^# //' | sed 's/^#//'
    exit 0
fi

# ============================================================================
# Logging and progress helpers
# ============================================================================

_log_initialized=false

init_logging() {
    mkdir -p "$(dirname "$LOG_FILE")"
    _log_initialized=true
}

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg"
    if $_log_initialized; then
        echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
    fi
}

log_error() {
    log "ERROR: $*"
}

log_warn() {
    log "WARNING: $*"
}

# Write progress JSON for the web UI to poll
write_progress() {
    local step="$1"
    local action="$2"
    local step_progress="${3:-0}"
    local error="${4:-}"

    local overall
    if [[ $TOTAL_STEPS -gt 0 ]]; then
        overall=$(awk "BEGIN {printf \"%.3f\", ($step - 1 + $step_progress) / $TOTAL_STEPS}")
    else
        overall="0"
    fi

    local error_field="null"
    if [[ -n "$error" ]]; then
        # Escape quotes in error message for JSON
        local escaped_error
        escaped_error=$(echo "$error" | sed 's/"/\\"/g' | tr '\n' ' ')
        error_field="\"$escaped_error\""
    fi

    mkdir -p "$(dirname "$PROGRESS_FILE")"
    cat > "$PROGRESS_FILE" <<JSONEOF
{
  "step": $step,
  "totalSteps": $TOTAL_STEPS,
  "currentAction": "$(echo "$action" | sed 's/"/\\"/g')",
  "progress": $step_progress,
  "overallProgress": $overall,
  "error": $error_field,
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
JSONEOF
}

# Run a command (or just log it in dry-run mode)
run_cmd() {
    if $DRY_RUN; then
        log "[DRY RUN] Would execute: $*"
        return 0
    fi
    log "Executing: $*"
    "$@"
}

# Check if we should run a given step
should_run_step() {
    local step_num="$1"
    [[ "$step_num" -ge "$START_STEP" ]]
}

# Size string (like "40G") to bytes
size_to_bytes() {
    local size="$1"
    local num="${size%[GgMm]}"
    local suffix="${size: -1}"
    case "$suffix" in
        G|g) echo $((num * 1024 * 1024 * 1024)) ;;
        M|m) echo $((num * 1024 * 1024)) ;;
        *)   echo $((size * 1024 * 1024 * 1024)) ;;  # default to GB
    esac
}

# Detect Pi model for MaxPower setting
detect_pi_model() {
    if [[ -f /proc/device-tree/model ]]; then
        local model
        model=$(tr -d '\0' < /proc/device-tree/model)
        case "$model" in
            *"Pi 5"*)    echo "pi5" ;;
            *"Pi 4"*)    echo "pi4" ;;
            *"Pi Zero 2"*) echo "pi_zero2" ;;
            *"Pi Zero"*) echo "pi_zero" ;;
            *)           echo "unknown" ;;
        esac
    else
        echo "unknown"
    fi
}

max_power_for_model() {
    case "$(detect_pi_model)" in
        pi5)       echo 600 ;;
        pi4)       echo 500 ;;
        pi_zero2)  echo 200 ;;
        pi_zero)   echo 100 ;;
        *)         echo 250 ;;
    esac
}

# ============================================================================
# Step 1: Source configuration
# ============================================================================
step_1_source_config() {
    local step=1
    write_progress $step "Reading configuration..."

    if [[ -f "$CONFIG_PATH" ]]; then
        log "Sourcing config from $CONFIG_PATH"
        # shellcheck disable=SC1090
        source "$CONFIG_PATH"
        log "Configuration loaded successfully"
    else
        log_warn "Config file not found at $CONFIG_PATH — using defaults"
    fi

    # Apply defaults for anything not set
    export DATA_DRIVE="${DATA_DRIVE:-$DEFAULT_DATA_DRIVE}"
    export CAM_SIZE="${CAM_SIZE:-$DEFAULT_CAM_SIZE}"
    export MUSIC_SIZE="${MUSIC_SIZE:-$DEFAULT_MUSIC_SIZE}"
    export LIGHTSHOW_SIZE="${LIGHTSHOW_SIZE:-$DEFAULT_LIGHTSHOW_SIZE}"
    export BOOMBOX_SIZE="${BOOMBOX_SIZE:-$DEFAULT_BOOMBOX_SIZE}"
    # Normalize USE_EXFAT: config may set USE_EXFAT=true or FILESYSTEMS=exfat
    if [[ "${USE_EXFAT:-}" == "true" ]] || [[ "${FILESYSTEMS:-}" == "exfat" ]]; then
        export USE_EXFAT="exfat"
    else
        export USE_EXFAT="${FILESYSTEMS:-$DEFAULT_FILESYSTEM}"
    fi
    export MUTABLE_SIZE="${MUTABLE_SIZE:-$DEFAULT_MUTABLE_SIZE}"

    log "DATA_DRIVE=$DATA_DRIVE"
    log "CAM_SIZE=$CAM_SIZE, MUSIC_SIZE=$MUSIC_SIZE"
    log "LIGHTSHOW_SIZE=$LIGHTSHOW_SIZE, BOOMBOX_SIZE=$BOOMBOX_SIZE"
    log "Filesystem=$USE_EXFAT"

    write_progress $step "Configuration loaded" 1
}

# ============================================================================
# Step 2: Validate prerequisites
# ============================================================================
step_2_validate_prerequisites() {
    local step=2
    write_progress $step "Validating prerequisites..."
    local errors=0

    # Must be root
    if [[ $EUID -ne 0 ]] && ! $DRY_RUN; then
        log_error "This script must be run as root (current EUID=$EUID)"
        errors=$((errors + 1))
    fi

    write_progress $step "Checking data drive..." 0.2

    # DATA_DRIVE must exist and be a block device
    if [[ ! -b "$DATA_DRIVE" ]] && ! $DRY_RUN; then
        log_error "DATA_DRIVE=$DATA_DRIVE is not a block device or does not exist"
        errors=$((errors + 1))
    else
        local drive_size
        drive_size=$(lsblk -b -d -n -o SIZE "$DATA_DRIVE" 2>/dev/null || echo "unknown")
        log "DATA_DRIVE=$DATA_DRIVE detected, size=$drive_size bytes"
    fi

    write_progress $step "Checking required packages..." 0.5

    # Check required packages by the commands they provide
    local missing_pkgs=()
    declare -A pkg_cmd_map=(
        [exfatprogs]="mkfs.exfat"
        [dosfstools]="mkfs.vfat"
        [parted]="partprobe"
        [gdisk]="sgdisk"
        [cifs-utils]="mount.cifs"
        [nfs-common]="mount.nfs"
    )
    for pkg in "${!pkg_cmd_map[@]}"; do
        local cmd="${pkg_cmd_map[$pkg]}"
        if ! command -v "$cmd" &>/dev/null; then
            missing_pkgs+=("$pkg")
        fi
    done

    if [[ ${#missing_pkgs[@]} -gt 0 ]]; then
        log_warn "Missing packages: ${missing_pkgs[*]}"
        if ! $DRY_RUN; then
            log "Installing missing packages..."
            apt-get update -qq
            apt-get install -y -qq "${missing_pkgs[@]}"
        fi
    fi

    write_progress $step "Checking kernel modules..." 0.8

    # Check dwc2 module availability
    if ! modinfo dwc2 &>/dev/null && ! $DRY_RUN; then
        log_error "dwc2 kernel module not available. USB gadget mode requires dwc2."
        errors=$((errors + 1))
    fi

    if [[ $errors -gt 0 ]]; then
        write_progress $step "Prerequisites check failed" 1 "$errors error(s) found"
        log_error "Prerequisites check failed with $errors error(s)"
        exit 1
    fi

    log "All prerequisites satisfied"
    write_progress $step "Prerequisites validated" 1
}

# ============================================================================
# Step 3: Configure USB gadget kernel modules
# ============================================================================
step_3_configure_kernel_modules() {
    local step=3
    write_progress $step "Configuring USB gadget kernel modules..."

    local config_txt="/boot/firmware/config.txt"
    local cmdline_txt="/boot/firmware/cmdline.txt"

    # Fallback for older Pi OS layout
    [[ -f "$config_txt" ]] || config_txt="/boot/config.txt"
    [[ -f "$cmdline_txt" ]] || cmdline_txt="/boot/cmdline.txt"

    # Ensure dtoverlay=dwc2 is in config.txt (needed for USB gadget mode).
    # IMPORTANT: Do NOT remove or modify the existing dtoverlay=dwc2,dr_mode=host
    # line — the Pi 4 needs it for the USB-C port to work as a host for the
    # external SSD. The gadget enable script handles switching to peripheral
    # mode at runtime via modprobe. The original teslausb kept both lines.
    write_progress $step "Checking config.txt for dwc2 overlay..." 0.3
    if grep -q "^dtoverlay=dwc2$" "$config_txt" 2>/dev/null; then
        log "dtoverlay=dwc2 already present in $config_txt"
    else
        log "Adding dtoverlay=dwc2 to [all] section of $config_txt"
        if ! $DRY_RUN; then
            # Add under [all] section if it exists, otherwise append
            if grep -q "^\[all\]" "$config_txt" 2>/dev/null; then
                sed -i '/^\[all\]/a dtoverlay=dwc2' "$config_txt"
            else
                echo -e "\n[all]\ndtoverlay=dwc2" >> "$config_txt"
            fi
        fi
    fi

    # NOTE: We do NOT add modules-load=dwc2 to cmdline.txt.
    # Loading dwc2 at boot before gadget is configured can hang the Pi.
    # Instead, the gadget enable script loads dwc2 and libcomposite on demand.
    # Remove it if a previous failed setup left it there.
    write_progress $step "Checking cmdline.txt for stale dwc2 module load..." 0.6
    if grep -q "modules-load=dwc2" "$cmdline_txt" 2>/dev/null; then
        log "Removing modules-load=dwc2 from $cmdline_txt (loaded on demand instead)"
        if ! $DRY_RUN; then
            sed -i 's/ modules-load=dwc2//' "$cmdline_txt"
        fi
    fi

    # Same for libcomposite — load on demand, not at boot
    write_progress $step "Checking /etc/modules..." 0.9
    if grep -q "^libcomposite" /etc/modules 2>/dev/null; then
        log "Removing libcomposite from /etc/modules (loaded on demand instead)"
        if ! $DRY_RUN; then
            sed -i '/^libcomposite/d' /etc/modules
        fi
    fi

    log "Kernel module configuration complete"
    write_progress $step "Kernel modules configured" 1
}

# ============================================================================
# Step 4: Partition the external drive
# ============================================================================
step_4_partition_drive() {
    local step=4
    write_progress $step "Partitioning external drive..."

    # Check if drive is already partitioned correctly
    local mutable_part="${DATA_DRIVE}1"
    local backingfiles_part="${DATA_DRIVE}2"

    # For NVMe drives, partition naming is different
    if [[ "$DATA_DRIVE" == *nvme* ]]; then
        mutable_part="${DATA_DRIVE}p1"
        backingfiles_part="${DATA_DRIVE}p2"
    fi

    local need_partition=false

    if [[ -b "$mutable_part" ]] && [[ -b "$backingfiles_part" ]]; then
        local label1 label2
        label1=$(blkid -s LABEL -o value "$mutable_part" 2>/dev/null || echo "")
        label2=$(blkid -s LABEL -o value "$backingfiles_part" 2>/dev/null || echo "")
        if [[ "$label1" == "mutable" ]] && [[ "$label2" == "backingfiles" ]]; then
            log "Drive already partitioned correctly (mutable + backingfiles)"
        else
            log "Partitions exist but labels don't match (got: '$label1', '$label2'). Will repartition."
            need_partition=true
        fi
    else
        need_partition=true
    fi

    if $need_partition; then
        log "Creating GPT partition table on $DATA_DRIVE"
        write_progress $step "Creating partition table on $DATA_DRIVE..." 0.2

        if ! $DRY_RUN; then
            # Wipe existing partition table
            wipefs -a "$DATA_DRIVE"

            # Use sgdisk for scriptable GPT partitioning
            # Partition 1: mutable (2GB) - ext4 for logs/state/DB
            # Partition 2: backingfiles (remainder) - ext4 for disk images
            local mutable_sectors
            mutable_sectors=$(( $(size_to_bytes "$MUTABLE_SIZE") / 512 ))
            sgdisk --zap-all "$DATA_DRIVE"
            sgdisk -n 1:0:+"${mutable_sectors}" -c 1:mutable -t 1:8300 "$DATA_DRIVE"
            sgdisk -n 2:0:0 -c 2:backingfiles -t 2:8300 "$DATA_DRIVE"

            # Wait for kernel to pick up partition changes
            partprobe "$DATA_DRIVE"
            sleep 2
        fi

        log "Partition table created successfully"
    fi

    # Export partition device paths for later steps
    export MUTABLE_PART="$mutable_part"
    export BACKINGFILES_PART="$backingfiles_part"

    write_progress $step "Drive partitioned" 1
}

# ============================================================================
# Step 5: Format and mount partitions
# ============================================================================
step_5_format_and_mount() {
    local step=5
    write_progress $step "Formatting and mounting partitions..."

    # Re-derive partition paths in case step 4 was skipped
    local mutable_part="${MUTABLE_PART:-${DATA_DRIVE}1}"
    local backingfiles_part="${BACKINGFILES_PART:-${DATA_DRIVE}2}"
    if [[ "$DATA_DRIVE" == *nvme* ]]; then
        mutable_part="${MUTABLE_PART:-${DATA_DRIVE}p1}"
        backingfiles_part="${BACKINGFILES_PART:-${DATA_DRIVE}p2}"
    fi

    # Format mutable partition if needed
    write_progress $step "Formatting mutable partition..." 0.1
    local mutable_fstype
    mutable_fstype=$(blkid -s TYPE -o value "$mutable_part" 2>/dev/null || echo "")
    if [[ "$mutable_fstype" != "ext4" ]]; then
        log "Formatting $mutable_part as ext4 with label 'mutable'"
        run_cmd mkfs.ext4 -F -L mutable "$mutable_part"
    else
        local current_label
        current_label=$(blkid -s LABEL -o value "$mutable_part" 2>/dev/null || echo "")
        if [[ "$current_label" != "mutable" ]]; then
            log "Setting label on $mutable_part to 'mutable'"
            run_cmd e2label "$mutable_part" mutable
        fi
        log "Mutable partition already formatted as ext4"
    fi

    # Format backingfiles partition if needed
    # Use lazy initialization to avoid extremely long format times on large drives
    # (e.g., 1.8TB can take 30+ minutes with full init and may trigger undervoltage USB disconnects)
    write_progress $step "Formatting backingfiles partition..." 0.3
    local bf_fstype
    bf_fstype=$(blkid -s TYPE -o value "$backingfiles_part" 2>/dev/null || echo "")
    if [[ "$bf_fstype" != "ext4" ]]; then
        log "Formatting $backingfiles_part as ext4 with label 'backingfiles' (lazy init)"
        run_cmd mkfs.ext4 -F -E lazy_itable_init=1,lazy_journal_init=1 -L backingfiles "$backingfiles_part"
    else
        local current_label
        current_label=$(blkid -s LABEL -o value "$backingfiles_part" 2>/dev/null || echo "")
        if [[ "$current_label" != "backingfiles" ]]; then
            log "Setting label on $backingfiles_part to 'backingfiles'"
            run_cmd e2label "$backingfiles_part" backingfiles
        fi
        log "Backingfiles partition already formatted as ext4"
    fi

    # Create mount points
    write_progress $step "Mounting partitions..." 0.5
    run_cmd mkdir -p /mutable /backingfiles

    # Mount if not already mounted
    if ! findmnt --mountpoint /mutable &>/dev/null; then
        log "Mounting $mutable_part at /mutable"
        run_cmd mount "$mutable_part" /mutable
    else
        log "/mutable already mounted"
    fi

    if ! findmnt --mountpoint /backingfiles &>/dev/null; then
        log "Mounting $backingfiles_part at /backingfiles"
        run_cmd mount "$backingfiles_part" /backingfiles
    else
        log "/backingfiles already mounted"
    fi

    # Ensure TeslaPi state directory exists on mutable
    run_cmd mkdir -p /mutable/teslapi
    run_cmd mkdir -p /mutable/TeslaCam

    # Add to fstab with nofail so boot never hangs if drive is missing
    write_progress $step "Updating /etc/fstab..." 0.8
    if ! grep -q "LABEL=mutable" /etc/fstab 2>/dev/null; then
        log "Adding mutable to /etc/fstab (nofail)"
        run_cmd bash -c "echo 'LABEL=mutable /mutable ext4 defaults,noatime,nofail,x-systemd.device-timeout=5s 0 2' >> /etc/fstab"
    fi
    if ! grep -q "LABEL=backingfiles" /etc/fstab 2>/dev/null; then
        log "Adding backingfiles to /etc/fstab (nofail)"
        run_cmd bash -c "echo 'LABEL=backingfiles /backingfiles ext4 defaults,noatime,nofail,x-systemd.device-timeout=5s 0 2' >> /etc/fstab"
    fi

    log "Partitions formatted and mounted"
    write_progress $step "Partitions ready" 1
}

# ============================================================================
# Step 6: Create backing file images
# ============================================================================
step_6_create_backing_files() {
    local step=6
    write_progress $step "Creating backing file images..."

    # Array of (name, size_var, label)
    local -a drives=()
    [[ -n "$CAM_SIZE" ]]       && drives+=("cam:$CAM_SIZE:CAM")
    [[ -n "$MUSIC_SIZE" ]]     && drives+=("music:$MUSIC_SIZE:MUSIC")
    [[ -n "$LIGHTSHOW_SIZE" ]] && drives+=("lightshow:$LIGHTSHOW_SIZE:LIGHTSHOW")
    [[ -n "$BOOMBOX_SIZE" ]]   && drives+=("boombox:$BOOMBOX_SIZE:BOOMBOX")

    if [[ ${#drives[@]} -eq 0 ]]; then
        log_warn "No drive sizes configured. At minimum, CAM_SIZE should be set."
        write_progress $step "No drives to create" 1
        return
    fi

    local total=${#drives[@]}
    local idx=0

    for entry in "${drives[@]}"; do
        IFS=':' read -r name size label <<< "$entry"
        local image_path="/backingfiles/${name}_disk.bin"
        local step_progress
        step_progress=$(awk "BEGIN {printf \"%.2f\", $idx / $total}")

        write_progress $step "Creating ${name} disk image (${size})..." "$step_progress"

        local target_bytes
        target_bytes=$(size_to_bytes "$size")

        if [[ -f "$image_path" ]]; then
            local current_size
            current_size=$(stat -c%s "$image_path" 2>/dev/null || echo "0")
            if [[ "$current_size" -eq "$target_bytes" ]]; then
                log "$image_path already exists with correct size ($size)"
                idx=$((idx + 1))
                continue
            else
                log "$image_path exists but wrong size (current=$current_size, target=$target_bytes). Recreating."
                run_cmd rm -f "$image_path"
            fi
        fi

        log "Creating $image_path ($size)..."
        if ! $DRY_RUN; then
            # Verify exfatprogs is installed if using exfat
            if [[ "$USE_EXFAT" == "exfat" ]] && ! command -v mkfs.exfat &>/dev/null; then
                log_error "mkfs.exfat not found. Install exfatprogs: apt-get install -y exfatprogs"
                return 1
            fi

            # Use truncate for instant sparse file creation.
            # The file appears as the full size but only uses actual disk space
            # as data is written. This avoids the sustained write that causes
            # USB SSD disconnects due to undervoltage on Pi 4.
            # fallocate pre-allocates blocks but triggers heavy I/O.
            truncate -s "$target_bytes" "$image_path"
            log "Created sparse file $image_path ($size)"

            # Format the image directly (no partition table inside).
            # Tesla reads the raw USB mass storage LUN as a single filesystem.
            if [[ "$USE_EXFAT" == "exfat" ]]; then
                mkfs.exfat -n "$label" "$image_path"
            else
                mkfs.ext4 -F -L "$label" "$image_path"
            fi

            log "Created and formatted $image_path ($size, $USE_EXFAT, label=$label)"
        fi

        idx=$((idx + 1))
    done

    write_progress $step "Backing files created" 1
}

# ============================================================================
# Step 7: Configure automount for backing files
# ============================================================================
step_7_configure_automount() {
    local step=7
    write_progress $step "Configuring mount points for backing files..."

    local -a mount_points=("cam" "music" "lightshow" "boombox")

    for mp in "${mount_points[@]}"; do
        local mount_dir="/mnt/$mp"
        local image="/backingfiles/${mp}_disk.bin"

        run_cmd mkdir -p "$mount_dir"

        if [[ -f "$image" ]]; then
            log "Mount point $mount_dir configured for $image"
        fi
    done

    # Note: The actual mounting of backing files is done by the archive loop
    # and the gadget scripts. We just ensure mount points exist.
    # The legacy teslausb uses mountimage script with loop devices.

    log "Mount points configured"
    write_progress $step "Mount points ready" 1
}

# ============================================================================
# Step 8: Install gadget scripts
# ============================================================================
step_8_install_gadget_scripts() {
    local step=8
    write_progress $step "Installing USB gadget scripts..."

    local bin_dir="/root/bin"
    local deploy_dir="/opt/teslapi/deploy"

    run_cmd mkdir -p "$bin_dir"

    write_progress $step "Installing TeslaPi gadget scripts..." 0.3

    # Install our own gadget enable/disable scripts from the deploy directory
    for script in teslapi-gadget-enable.sh teslapi-gadget-disable.sh; do
        if [[ -f "$deploy_dir/$script" ]]; then
            run_cmd cp "$deploy_dir/$script" "$bin_dir/$script"
            run_cmd chmod +x "$bin_dir/$script"
            log "Installed $bin_dir/$script"
        else
            log_warn "Gadget script not found: $deploy_dir/$script"
        fi
    done

    # Also copy legacy teslausb scripts if available (for archive loop compatibility)
    local source_dir
    source_dir="$(cd "$(dirname "$0")/.." && pwd)/run"
    if [[ ! -d "$source_dir" ]]; then
        source_dir="/opt/teslapi/run"
    fi

    write_progress $step "Copying helper scripts..." 0.7

    local -a helper_scripts=("mountimage" "mountoptsforimage" "envsetup.sh")
    for script in "${helper_scripts[@]}"; do
        if [[ -f "$source_dir/$script" ]]; then
            run_cmd cp "$source_dir/$script" "$bin_dir/$script"
            run_cmd chmod +x "$bin_dir/$script"
        fi
    done

    log "Gadget scripts installed"
    write_progress $step "Gadget scripts installed" 1
}

# ============================================================================
# Step 9: Install archive loop
# ============================================================================
step_9_install_archive_loop() {
    local step=9
    write_progress $step "Installing archive loop service..."

    local source_dir
    source_dir="$(cd "$(dirname "$0")/.." && pwd)/run"
    if [[ ! -d "$source_dir" ]]; then
        source_dir="/opt/teslapi/run"
    fi

    local bin_dir="/root/bin"

    # Copy archive-related scripts
    local -a archive_scripts=(
        "archiveloop"
        "waitforidle"
        "archive-is-reachable.sh"
        "connect-archive.sh"
        "disconnect-archive.sh"
        "archive-clips.sh"
        "copy-music.sh"
        "send-push-message"
        "make_snapshot.sh"
        "manage_free_space.sh"
        "temperature_monitor"
        "awake_start"
        "awake_stop"
    )

    write_progress $step "Copying archive scripts..." 0.3

    for script in "${archive_scripts[@]}"; do
        if [[ -f "$source_dir/$script" ]]; then
            run_cmd cp "$source_dir/$script" "$bin_dir/$script"
            run_cmd chmod +x "$bin_dir/$script"
        fi
    done

    # Also copy archive backend scripts (cifs/nfs specific)
    for backend_script in "$source_dir"/archive-*; do
        if [[ -f "$backend_script" ]]; then
            run_cmd cp "$backend_script" "$bin_dir/$(basename "$backend_script")"
            run_cmd chmod +x "$bin_dir/$(basename "$backend_script")"
        fi
    done

    # Install systemd service for teslausb (archive daemon)
    write_progress $step "Installing systemd service..." 0.6
    if ! $DRY_RUN; then
        cat > /etc/systemd/system/teslausb.service <<'SVCEOF'
[Unit]
Description=TeslaPi Archive Loop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/root/bin/archiveloop
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

        systemctl daemon-reload
        systemctl enable teslausb.service
        log "teslausb.service installed and enabled"
    fi

    write_progress $step "Archive loop installed" 1
}

# ============================================================================
# Step 10: Configure archive backend
# ============================================================================
step_10_configure_archive_backend() {
    local step=10
    write_progress $step "Configuring archive backend..."

    local archive_system="${ARCHIVE_SYSTEM:-none}"

    case "$archive_system" in
        cifs)
            log "Configuring CIFS archive backend"
            write_progress $step "Setting up CIFS credentials..." 0.3

            if ! $DRY_RUN; then
                # Create CIFS credentials file
                local creds_file="/root/.teslapi_archive_creds"
                cat > "$creds_file" <<CREDSEOF
username=${SHARE_USER:-}
password=${SHARE_PASSWORD:-}
domain=${SHARE_DOMAIN:-}
CREDSEOF
                chmod 600 "$creds_file"
                log "CIFS credentials written to $creds_file"
            fi

            # Create archive mount point
            run_cmd mkdir -p /mnt/archive
            if [[ -n "${MUSIC_SHARE_NAME:-}" ]]; then
                run_cmd mkdir -p /mnt/musicarchive
            fi
            ;;
        nfs)
            log "Configuring NFS archive backend"
            run_cmd mkdir -p /mnt/archive
            if [[ -n "${MUSIC_SHARE_NAME:-}" ]]; then
                run_cmd mkdir -p /mnt/musicarchive
            fi
            ;;
        rsync)
            log "Configuring rsync archive backend"
            ;;
        rclone)
            log "Configuring rclone archive backend"
            ;;
        none)
            log "No archive backend configured. Dashcam clips will not be archived."
            ;;
        *)
            log_warn "Unknown archive system: $archive_system"
            ;;
    esac

    write_progress $step "Archive backend configured" 1
}

# ============================================================================
# Step 11: Install TeslaPi web service
# ============================================================================
step_11_install_web_service() {
    local step=11
    write_progress $step "Checking TeslaPi web service..."

    if systemctl is-enabled teslapi.service &>/dev/null; then
        log "teslapi.service already installed and enabled"
    else
        log "TeslaPi web service not yet installed. It will be set up by deploy/install.sh"
    fi

    # Ensure nginx config is in place if nginx is installed
    if command -v nginx &>/dev/null; then
        if [[ -f /etc/nginx/sites-available/teslapi ]]; then
            log "Nginx configuration for TeslaPi already present"
        else
            log "Nginx config not found — will be installed by deploy/configure-web.sh"
        fi
    fi

    write_progress $step "Web service checked" 1
}

# ============================================================================
# Step 12: Write completion marker
# ============================================================================
step_12_write_completion() {
    local step=12
    write_progress $step "Writing completion marker..."

    if ! $DRY_RUN; then
        mkdir -p "$(dirname "$COMPLETION_FILE")"

        # Generate config hash for change detection
        local config_hash="none"
        if [[ -f "$CONFIG_PATH" ]]; then
            config_hash=$(sha256sum "$CONFIG_PATH" | awk '{print $1}')
        fi

        cat > "$COMPLETION_FILE" <<COMPEOF
{
  "complete": true,
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "version": "$SCRIPT_VERSION",
  "configHash": "$config_hash",
  "configPath": "$CONFIG_PATH",
  "dataDrive": "$DATA_DRIVE",
  "camSize": "$CAM_SIZE",
  "musicSize": "${MUSIC_SIZE:-none}",
  "lightshowSize": "${LIGHTSHOW_SIZE:-none}",
  "boomboxSize": "${BOOMBOX_SIZE:-none}",
  "filesystem": "$USE_EXFAT",
  "archiveSystem": "${ARCHIVE_SYSTEM:-none}",
  "dryRun": $DRY_RUN
}
COMPEOF
        log "Completion marker written to $COMPLETION_FILE"
    fi

    write_progress $step "Completion marker written" 1
}

# ============================================================================
# Step 13: Summary and next steps
# ============================================================================
step_13_summary() {
    local step=13
    write_progress $step "Setup complete!" 1

    echo ""
    echo "=============================================="
    echo "  TeslaPi Setup Complete"
    echo "=============================================="
    echo ""
    echo "  Data drive:    $DATA_DRIVE"
    echo "  Mutable:       /mutable (mounted)"
    echo "  Backingfiles:  /backingfiles (mounted)"
    echo ""

    if [[ -n "$CAM_SIZE" ]]; then
        echo "  Dashcam:       $CAM_SIZE ($USE_EXFAT)"
    fi
    if [[ -n "${MUSIC_SIZE:-}" ]]; then
        echo "  Music:         $MUSIC_SIZE ($USE_EXFAT)"
    fi
    if [[ -n "${LIGHTSHOW_SIZE:-}" ]]; then
        echo "  Light Show:    $LIGHTSHOW_SIZE ($USE_EXFAT)"
    fi
    if [[ -n "${BOOMBOX_SIZE:-}" ]]; then
        echo "  Boombox:       $BOOMBOX_SIZE ($USE_EXFAT)"
    fi

    echo ""
    echo "  Archive:       ${ARCHIVE_SYSTEM:-none}"
    echo "  Gadget:        Configured (will activate after reboot)"
    echo ""

    if $DRY_RUN; then
        echo "  ** DRY RUN — no changes were actually made **"
        echo ""
    fi

    echo "  Next steps:"
    echo "    1. Review the configuration"
    echo "    2. Reboot the Pi: sudo reboot"
    echo "    3. Connect the Pi to your Tesla's USB port"
    echo ""
    echo "=============================================="

    log "Setup completed successfully"
}

# ============================================================================
# Main execution
# ============================================================================
main() {
    echo "TeslaPi Setup v${SCRIPT_VERSION}"
    echo ""

    if $DRY_RUN; then
        echo "*** DRY RUN MODE — no changes will be made ***"
        echo ""
    fi

    # Initialize logging (creates /mutable/teslapi if possible)
    if [[ -d /mutable ]] || $DRY_RUN; then
        init_logging
    fi

    local -a steps=(
        "step_1_source_config"
        "step_2_validate_prerequisites"
        "step_3_configure_kernel_modules"
        "step_4_partition_drive"
        "step_5_format_and_mount"
        "step_6_create_backing_files"
        "step_7_configure_automount"
        "step_8_install_gadget_scripts"
        "step_9_install_archive_loop"
        "step_10_configure_archive_backend"
        "step_11_install_web_service"
        "step_12_write_completion"
        "step_13_summary"
    )

    # Now that step 1 may create /mutable, reinitialize logging
    # after step 5 (which mounts /mutable)

    local step_num=0
    for step_fn in "${steps[@]}"; do
        step_num=$((step_num + 1))
        if should_run_step "$step_num"; then
            log "--- Step $step_num/$TOTAL_STEPS: $step_fn ---"
            if ! $step_fn; then
                local err_msg="Step $step_num ($step_fn) failed"
                log_error "$err_msg"
                write_progress "$step_num" "$err_msg" 0 "$err_msg"
                exit 1
            fi

            # Re-init logging after mutable is mounted
            if [[ $step_num -eq 5 ]] && [[ -d /mutable ]]; then
                init_logging
            fi
        else
            log "Skipping step $step_num (starting from step $START_STEP)"
        fi
    done
}

# Trap errors for cleanup
trap 'write_progress ${step_num:-0} "Setup failed unexpectedly" 0 "Unexpected error at line $LINENO"' ERR

main "$@"
