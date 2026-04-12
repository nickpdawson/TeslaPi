#!/bin/bash

(sudo /root/bin/setup-teslausb diagnose) &> /tmp/diagnostics.txt

"$(dirname "$0")/reload.sh" "Sync triggered"
