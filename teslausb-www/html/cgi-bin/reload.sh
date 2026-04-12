#!/bin/bash

cat << EOF
HTTP/1.0 200 OK
Content-type: text/html

<html>
<head>
  <meta http-equiv="refresh" content="3; URL=/" />
</head>
<body>
  <p>$1</p>
</body>
</html>
EOF
