#!/bin/bash

"$(dirname "$0")/reload.sh" "Sync triggered"

sudo reboot &> /dev/null
