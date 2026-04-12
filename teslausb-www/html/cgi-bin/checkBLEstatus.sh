#!/bin/bash

VIN=$(sudo grep "^export TESLA_BLE_VIN=" /root/teslausb_setup_variables.conf | cut -d'=' -f2- | head -n 1)

if sudo /root/bin/tesla-control -ble -vin ${VIN^^} session-info /root/.ble/key_private.pem infotainment
then
  "$(dirname "$0")/reload.sh" "paired"
else
  "$(dirname "$0")/reload.sh" "not paired"
fi
