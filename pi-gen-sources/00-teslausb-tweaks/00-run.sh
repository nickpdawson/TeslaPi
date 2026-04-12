#!/bin/bash -e
touch "${ROOTFS_DIR}/boot/ssh"
install -m 755 files/rc.local                             "${ROOTFS_DIR}/etc/"
install -m 666 files/teslausb_setup_variables.conf.sample "${ROOTFS_DIR}/boot/firmware/teslausb_setup_variables.conf"
install -m 666 files/wpa_supplicant.conf.sample           "${ROOTFS_DIR}/boot/firmware"
install -m 666 files/run_once                             "${ROOTFS_DIR}/boot/firmware"
install -d "${ROOTFS_DIR}/root/bin"

# ensure dwc2 module is loaded
echo "dtoverlay=dwc2" >> "${ROOTFS_DIR}/boot/firmware/config.txt"

# remove unwanted packages, disable unwanted services, and disable swap
on_chroot << EOF
apt-get remove -y --force-yes --purge triggerhappy userconf-pi dphys-swapfile firmware-libertas firmware-realtek firmware-atheros mkvtoolnix
apt-get -y --force-yes autoremove
systemctl disable keyboard-setup
systemctl disable resize2fs_once
systemctl disable dpkg-db-backup
update-rc.d resize2fs_once remove
rm /etc/init.d/resize2fs_once
rm /usr/share/initramfs-tools/scripts/local-premount/firstboot
update-initramfs -u
EOF
