### Building a teslausb image

To build a ready to flash one-step setup image for CIFS, do the following:

1. Clone pi-gen from https://github.com/RPi-Distro/pi-gen
2. Follow the instructions in the pi-gen readme to install the required dependencies
3. From the RPi-Distro/pi-gen folder, run the `prepare.sh` script from TeslaUSB's pi-gen-sources folder
4. If needed, adjust ROOT_MARGIN or ROOT_PART_SIZE in pi-gen/export-image/prerun.sh to ensure sufficient free space left on the root partition of the generated image
5. Run `build.sh` or `build-docker.sh`, depending on how you want to build the image. The Docker build is recommended
6. Sit back and relax, this could take a while (for reference, on a dual-core 2.6 Ghz Intel Core i3 and 50 Mbps internet connection, it took under an hour)
   If all went well, the image will be in the `deploy` folder. Use Raspberry Pi Imager or a similar tool to flash it.
