#!/bin/bash

declare -a urlargs
IFS='&' read -r -a urlargs <<<"$QUERY_STRING" 

declare -i len=${#urlargs[@]}
for ((i=0; i<${len}; i++ ))
do
  val="${urlargs[i]//+/ }"
  urlargs[i]="$(echo -e "${val//%/\\x}")"
done

dir="$DOCUMENT_ROOT/${urlargs[0]}"
file="$DOCUMENT_ROOT/${urlargs[0]}/${urlargs[1]}"
if [[ "$len" == 2 && -d "$dir" && -f "$file" ]]
then
  str=$(file --mime-type "$file")
  mime=${str##*: }
  echo "HTTP/1.0 200 OK"
  echo "Content-type: $mime"
  echo
  cat "$file"
else
  echo "HTTP/1.0 200 OK"
  echo "Content-type: text/plain"
  echo
  echo "Bad request"
fi
