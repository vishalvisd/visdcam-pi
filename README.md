# visdcam-pi

Two ESP32-CAMs -> Raspberry Pi (GStreamer x264 -> MP4 segments in RAM) -> S3 uploader.

## Restore on a fresh Pi (RPi OS Lite 64-bit)

1) Base packages  
```bash
sudo apt-get update
sudo apt-get install -y gstreamer1.0-tools \
  gstreamer1.0-plugins-{base,good,bad,ugly} \
  awscli python3 git
Create RAM disk (tmpfs)
Add to /etc/fstab (adjust size if needed):

arduino
Copy code
tmpfs  /mnt/ramcam  tmpfs  rw,nosuid,nodev,mode=0755,size=768M  0 0
Then:

bash
Copy code
sudo mkdir -p /mnt/ramcam
echo -e "D /mnt/ramcam 0755 root root -\nd /mnt/ramcam/cam1 0755 visd visd -\nd /mnt/ramcam/cam2 0755 visd visd -" | \
  sudo tee /etc/tmpfiles.d/ramcam.conf
sudo mount -a
sudo systemd-tmpfiles --create
sudo chown -R visd:visd /mnt/ramcam
Copy files back to the same paths

bash
Copy code
sudo install -m0755 scripts/seg-cam1.sh /usr/local/bin/seg-cam1.sh
sudo install -m0755 scripts/seg-cam2.sh /usr/local/bin/seg-cam2.sh
sudo install -m0755 scripts/uploader-cam1.sh /usr/local/bin/uploader-cam1.sh
sudo install -m0755 scripts/uploader-cam2.sh /usr/local/bin/uploader-cam2.sh
sudo install -m0755 scripts/cctv-health-snap.sh /usr/local/bin/cctv-health-snap.sh
sudo install -m0755 scripts/visdcam /usr/local/bin/visdcam

sudo install -m0644 systemd/seg-cam1.service /etc/systemd/system/seg-cam1.service
sudo install -m0644 systemd/seg-cam2.service /etc/systemd/system/seg-cam2.service
sudo install -m0644 systemd/uploader-cam1.service /etc/systemd/system/uploader-cam1.service
sudo install -m0644 systemd/uploader-cam2.service /etc/systemd/system/uploader-cam2.service

sudo systemctl daemon-reload
sudo systemctl enable seg-cam1.service seg-cam2.service uploader-cam1.service uploader-cam2.service
AWS credentials for user visd (do NOT commit these)

swift
Copy code
/home/visd/.aws/credentials
/home/visd/.aws/config
Example:

ini
Copy code
[default]
aws_access_key_id=AKIA...
aws_secret_access_key=...

[config file]
[default]
region=ap-south-1
Start

bash
Copy code
sudo systemctl start seg-cam1.service seg-cam2.service uploader-cam1.service uploader-cam2.service
visdcam health
visdcam status
See visdcam info for quick commands.
