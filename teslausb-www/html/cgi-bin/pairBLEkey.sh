#!/bin/bash

VIN=$(sudo grep "^export TESLA_BLE_VIN=" /root/teslausb_setup_variables.conf | cut -d'=' -f2- | head -n 1)



message=$(sudo /root/bin/tesla-control -ble -vin ${VIN^^} add-key-request /root/.ble/key_public.pem owner cloud_key 2>&1)
result=$?

status_code="202 Accepted"
output="Pairing initiated."

if [[ $result -ne 0 ]]
then
  status_code="502 Bad Gateway"
  output="Failed to send pairing request. $message"
fi

cat << EOF
HTTP/1.0 $status_code
Content-type: text/html
Status: $status_code

<html>
<head>
  <meta http-equiv="refresh" content="3; URL=/" />
</head>
<body>
  <p>$output</p>
</body>
</html>
EOF
