#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad,ugly} awscli python3 git

RAM disk

if ! grep -q '/mnt/ramcam' /etc/fstab; then
echo 'tmpfs /mnt/ramcam tmpfs rw,nosuid,nodev,mode=0755,size=768M 0 0' | sudo tee -a /etc/fstab
fi
echo -e "D /mnt/ramcam 0755 root root -\nd /mnt/ramcam/cam1 0755 visd visd -\nd /mnt/ramcam/cam2 0755 visd visd -" |
sudo tee /etc/tmpfiles.d/ramcam.conf >/dev/null
sudo mkdir -p /mnt/ramcam
sudo mount -a
sudo systemd-tmpfiles --create
sudo chown -R visd:visd /mnt/ramcam

Install scripts

sudo install -m0755 scripts/seg-cam1.sh /usr/local/bin/seg-cam1.sh
sudo install -m0755 scripts/seg-cam2.sh /usr/local/bin/seg-cam2.sh
sudo install -m0755 scripts/uploader-cam1.sh /usr/local/bin/uploader-cam1.sh
sudo install -m0755 scripts/uploader-cam2.sh /usr/local/bin/uploader-cam2.sh
sudo install -m0755 scripts/cctv-health-snap.sh /usr/local/bin/cctv-health-snap.sh
sudo install -m0755 scripts/visdcam /usr/local/bin/visdcam

Units

sudo install -m0644 systemd/seg-cam1.service /etc/systemd/system/seg-cam1.service
sudo install -m0644 systemd/seg-cam2.service /etc/systemd/system/seg-cam2.service
sudo install -m0644 systemd/uploader-cam1.service /etc/systemd/system/uploader-cam1.service
sudo install -m0644 systemd/uploader-cam2.service /etc/systemd/system/uploader-cam2.service

sudo systemctl daemon-reload
sudo systemctl enable seg-cam1.service seg-cam2.service uploader-cam1.service uploader-cam2.service

echo ">>> Install complete. Put AWS creds in /home/visd/.aws and run:"
echo " sudo systemctl start seg-cam1 seg-cam2 uploader-cam1 uploader-cam2"
