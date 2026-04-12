#!/bin/bash

cat << EOF
HTTP/1.0 200 OK
Content-type: text/plain

EOF
find /mutable/TeslaCam -type l -printf '%P\n' | sort
