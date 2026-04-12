# Introduction

This guide will show you how to use [rsync](https://rsync.samba.org/) to archive your saved TeslaCam footage on a remote storage server.

Since sftp/rsync accesses a computer through SSH the only requirement for hosting an SFTP/rsync server is to have a box running SSH. For example, you could use another Raspberry Pi connected to your local network with a USB storage drive plugged in. The official Raspberry Pi site has a good example on [how to mount an external drive](https://www.raspberrypi.org/documentation/configuration/external-storage.md).

You will need the username and host/IP of the storage server, as well as the path for the files to go in, and the storage server will need to allow SSH.

This guide makes the following assumptions:

- You are running your own sftp/rsync server that you have admin rights to, or can at least add a public key to its `~/.ssh/authorized_keys` file.
- The sftp/rsync server has rsync installed (raspbian automatically does)

# Step 1: Authentication

Similar to sftp, rsync by default uses ssh to connect to a remote server and transfer files. This guide will use a generated ssh keypair, hence the first assumption above.

1. Enter the root session (if you haven't already):

   ```
   sudo -i
   ```

1. Remount the file system as read-write:

   ```
   bin/remountfs_rw
   ```

1. Run these commands to to generate an ssh key for the `root` user:

   ```
   ssh-keygen
   ```

1. Copy the key to the storage server. This will also add the server to `.ssh/known_hosts`:
   ```
   ssh-copy-id user@archiveserver
   ```

# Step 2: Exports

Run this command to cause the setup processes which you'll resume in the main instructions to use rsync:

```
export ARCHIVE_SYSTEM=rsync
export RSYNC_USER=<sftp username>
export RSYNC_SERVER=<sftp IP/host>
export RSYNC_PATH=<destination path to save in>
```

Explanations for each:

- `ARCHIVE_SYSTEM`: `rsync` for enabling rsync
- `RSYNC_USER`: The user on the SFTP server
- `RSYNC_SERVER`: The IP address/hostname of the destination machine
- `RSYNC_PATH`: The path on the destination machine where the files will be saved

An example config is below:

```
export ARCHIVE_SYSTEM=rsync
export RSYNC_USER=pi
export RSYNC_SERVER=192.168.1.254
export RSYNC_PATH=/mnt/PIHDD/TeslaCam/
```

Additional options for rsync over ssh can be configured using `~/.ssh/config` such as port number. To see all available options visit [the man page](https://linux.die.net/man/5/ssh_config).

Stay in the `sudo -i` session return to the section "Set up the USB storage functionality" in the [main instructions](../README.md).
