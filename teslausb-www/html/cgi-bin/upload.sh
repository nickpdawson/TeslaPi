#!/bin/bash

declare -a urlargs
IFS='&' read -r -a urlargs <<<"$QUERY_STRING" 

declare -i len=${#urlargs[@]}
for ((i=0; i<${len}; i++ ))
do
  val="${urlargs[i]//+/ }"
  urlargs[i]="$(echo -e "${val//%/\\x}")"
done

cd "$DOCUMENT_ROOT/${urlargs[0]}"

destpath="${urlargs[1]}"
echo $destpath >> /tmp/upload.txt
destdir=${destpath%/*}
if [ "$destdir" = "$destpath" ]
then
  destdir=.
fi

if [ "$REQUEST_METHOD" = "POST" ]
then
  if [ "$CONTENT_LENGTH" -gt 0 ]
  then
    if mkdir -p "$destdir" && cat > "$destpath"
    then
			cat <<- EOF
			HTTP/1.0 200 OK
			Content-type: text/plain

			EOF
      exit 0
    fi
  fi
fi

cat << EOF
HTTP/1.0 413 OK
Content-type: text/plain

EOF
