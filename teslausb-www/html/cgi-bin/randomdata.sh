#!/bin/bash

cat << EOF
HTTP/1.0 200 OK
Content-type: application/octet-stream

EOF

dd if=/dev/urandom of=/tmp/randomdata$$ bs=1M count=1
while cat /tmp/randomdata$$
do
  true
done

rm /tmp/randomdata$$
