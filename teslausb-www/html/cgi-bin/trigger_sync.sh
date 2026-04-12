#!/bin/bash

touch /tmp/archive_is_unreachable

"$(dirname "$0")/reload.sh" "Sync triggered"
