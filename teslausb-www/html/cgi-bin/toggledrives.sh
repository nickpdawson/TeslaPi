#!/bin/bash

if [ -e "/sys/kernel/config/usb_gadget/teslausb/" ]
then
  sudo /root/bin/disable_gadget.sh
else
  sudo /root/bin/enable_gadget.sh
fi

cat << EOF
HTTP/1.0 200 OK
Content-type: application/json

EOF
