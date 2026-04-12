#!/bin/bash -eu

function usage {
  echo "usage: $0 <size> <image>"
}

function dehumanize () {
  echo $(($(echo "$1" | sed 's/GB/G/;s/MB/M/;s/KB/K/;s/G/*1024M/;s/M/*1024K/;s/K/*1024/')))
}

function closeenough () {
  DIFF=$(($1-$2))
  if [ $DIFF -ge 0 ] && [ $DIFF -lt 1048576 ]
  then
    true
    return
  elif [ $DIFF -lt 0 ] && [ $DIFF -gt -1048576 ]
  then
    true
    return
  fi
  false
}

if [[ $# -ne 2 ]]
then
  usage
  exit
fi

NEWSIZE=$(dehumanize "$1")
FILE=$2

if [ ! -e "$FILE" ]
then
  echo "No such file: $FILE"
  usage
  exit
fi

# install fatresize if needed
if ! hash fatresize &> /dev/null
then
  /root/bin/remountfs_rw
  apt install -y fatresize
fi

if findmnt /mnt/cam > /dev/null
then
  echo "cam drive is mounted. Please ensure no archiving operation is in progress"
  exit
fi

if findmnt /mnt/music > /dev/null
then
  echo "music drive is mounted. Please ensure no music sync operation is in progress"
  exit
fi

# remove device from any attached host
/root/bin/disable_gadget.sh

# fsck the image, since we may have just yanked it out from under the host.
# Use -p repair arg. It works with vfat and exfat.
DEVLOOP=$(losetup --show -P -f "$FILE")
PARTLOOP=${DEVLOOP}p1
fsck "$PARTLOOP" -- -p > /dev/null || true

# get size of the image file and the partition within
CURRENT_PARTITION_SIZE=$(($(partx -o SECTORS -g -n 1 "$FILE") * 512 + 512))
PARTITION_OFFSET=$(($(partx -o START -g -n 1 "$FILE") * 512))

# fatresize doesn't seem to like extending partitions to the very end of the file
# and sometimes segfault in that case, so add some padding
PARTITION_PADDING=65536

if closeenough $CURRENT_PARTITION_SIZE "$NEWSIZE"
then
  echo "no sizing needed"
elif [ $CURRENT_PARTITION_SIZE -lt "$NEWSIZE" ]
then
  echo "growing"
  fallocate -l $((PARTITION_OFFSET + NEWSIZE + PARTITION_PADDING)) "$FILE"
  fatresize -s "$NEWSIZE" "$FILE" > /dev/null
else
  echo "shrinking"
  if fatresize -s "$NEWSIZE" "$FILE" > /dev/null
  then
    PARTITION_END=$(($(partx -o END -g -n 1 "$FILE") * 512 + 512))
    truncate -s $((PARTITION_END + PARTITION_PADDING)) "$FILE"
  else
    echo "resize failed, skipping image resizing"
  fi
fi

losetup -d "$DEVLOOP"

