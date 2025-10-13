# visdcam-pi

ESP32-Cam recorders on a Raspberry Pi.  
MJPEG → H.264 (x264) → **MPEG-TS segments** on RAM disk → BackBlaze B2.

**Why TS?** If a camera dies mid-segment, the resulting clip is still playable (best chance to capture the “last moment”).

## Features
- 2 cameras (`cam1`=192.168.1.33, `cam2`=192.168.1.36)
- Segments to `/mnt/ramcam/camX` as `home-cam-X-00000.ts`
- Uploader renames by IST mtime to `camX/YYYY/MM/DD/HH/cam_X_YYYY_MM_DD_hh_mm_ss.ts`
- Survives reboots; retries forever on camera outage
- Day/night preset at **06:00** and **18:00** IST
- Optional **egress shaper** (~3 Mb/s) so uploads never swamp the uplink
- `bin/visdcam` helper (`start/stop/restart/status/logs/lsram/clean/getdur/setdur/...`)

## Quick start
See `docs/INSTALL_PI.md` and `docs/AWS_CREDS.md`.

## Common commands
```bash
visdcam status
visdcam setdur cam1 180
visdcam restart cam1
visdcam logs cam2 --follow
visdcam lsram all



---

## What to do now

1) In GitHub, create/overwrite the files above with the exact content.
2) On the Pi, pull/update the repo and (re)install to the system paths:
   ```bash
   sudo install -m 755 scripts/*.sh /usr/local/bin/
   sudo install -m 644 systemd/*.service /etc/systemd/system/
   sudo install -m 644 systemd/*.timer   /etc/systemd/system/ || true
   sudo install -m 755 bin/visdcam /usr/local/bin/visdcam
   sudo install -m 644 etc/tmpfiles.d/ramcam.conf /etc/tmpfiles.d/ramcam.conf
   sudo systemd-tmpfiles --create /etc/tmpfiles.d/ramcam.conf
   sudo systemctl daemon-reload
   sudo systemctl enable --now seg-cam1.service seg-cam2.service uploader-cam1.service uploader-cam2.service visdcam-daynight.timer
   # optional:
   sudo systemctl enable --now net-shaper.service

3) Verify with visdcam status and watch RAM/S3.

If you want, I can also generate a single ZIP (golden reference) you can drop into GitHub — but the blocks above are everything you need to paste.





Using Backblaze B2 (S3-compatible) instead of AWS S3

This setup keeps the Pi unchanged except for the upload destination. We use the AWS CLI pointed at Backblaze B2’s S3 endpoint via a dedicated profile b2. No SD-card logging is done; uploader logs live in RAM under /run/visdcam.

Bucket & layout

Bucket: visd-cctv (B2 region: ca-east-006, endpoint: https://s3.ca-east-006.backblazeb2.com)

Object key layout:
cam{N}/YYYY/MM/DD/HH/cam_{N}_{YYYY}_{MM}_{DD}_{hh}_{mm}_{ss}.ts

Timestamps are derived from file mtime in Asia/Kolkata.

Example:

s3://visd-cctv/cam1/2025/10/12/17/cam_1_2025_10_12_17_42_22.ts

Configure the Pi for B2

Put B2 S3 keys in the b2 profile:

~/.aws/credentials

[b2]
aws_access_key_id = 006xxxxxxxxxxxx0003
aws_secret_access_key = <YOUR_B2_S3_SECRET>


~/.aws/config

[profile b2]
region = ca-east-006
s3 =
    signature_version = s3v4
    addressing_style = virtual


Quick test:

AWS_PROFILE=b2 aws --endpoint-url https://s3.ca-east-006.backblazeb2.com s3 ls s3://visd-cctv/

Services (segmenters + uploaders)

Start/stop via the helper:

sudo visdcam start all
sudo visdcam status
sudo visdcam stop all


Segmenters write .ts files into RAM at /mnt/ramcam/cam{1,2}; uploaders pick up closed files and send them to B2.

Uploader logging (RAM only)

Logs:

/run/visdcam/uploader-cam1.log

/run/visdcam/uploader-cam2.log

Tail:

tail -F /run/visdcam/uploader-cam1.log /run/visdcam/uploader-cam2.log


These logs live in RAM and disappear on reboot (by design).

Optional: throttle per-camera upload rate

Create (if needed) and edit:

/etc/default/uploader-cam1   # e.g. RATE_KBPS=500
/etc/default/uploader-cam2   # e.g. RATE_KBPS=500


Then:

sudo systemctl restart uploader-cam1.service uploader-cam2.service

Switching back to AWS S3 later (no code changes)

Ensure your default (or another) AWS profile has valid AWS keys/region.

Edit the two uploader scripts (or add /etc/default/uploader-cam{1,2}) to set:

B2_PROFILE=default
B2_REGION=<your-aws-region>
B2_ENDPOINT=https://s3.<your-aws-region>.amazonaws.com


Restart:

sudo systemctl restart uploader-cam1.service uploader-cam2.service

Verifying end-to-end

RAM files rolling:

visdcam lsram


Live bandwidth (for sanity):

bash -lc 'i=eth0; rxp=$(< /sys/class/net/$i/statistics/rx_bytes); txp=$(< /sys/class/net/$i/statistics/tx_bytes); \
while sleep 1; do rx=$(< /sys/class/net/$i/statistics/rx_bytes); tx=$(< /sys/class/net/$i/statistics/tx_bytes); \
printf "%s RX: %.2f Mb/s  TX: %.2f Mb/s\n" $i $(( (rx-rxp)*8/1000000 )) $(( (tx-txp)*8/1000000 )); rxp=$rx; txp=$tx; done'


List objects (B2):

AWS_PROFILE=b2 aws --endpoint-url https://s3.ca-east-006.backblazeb2.com s3 ls s3://visd-cctv/cam1/$(date +%Y)/ --recursive | tail

Troubleshooting

Uploader service flaps
Check permissions + logs:

sudo systemctl status uploader-cam1.service -l --no-pager
tail -n 200 /run/visdcam/uploader-cam1.log


Objects missing in bucket UI but logs show “upload OK”
B2’s UI list can lag briefly. Confirm via CLI:

AWS_PROFILE=b2 aws --endpoint-url https://s3.ca-east-006.backblazeb2.com \
  s3 ls s3://visd-cctv/cam1/$(TZ=Asia/Kolkata date +%Y/%m/%d/%H)/


Zero-byte “(started large file)” objects
Usually means the uploader crashed mid-stream. Check the RAM logs; ensure pv + aws are installed, and that the service is running.

Dependencies

awscli v2

pv

lsof

gzip (optional, not required by current scripts)

GStreamer (for the segmenters)

Install (Debian/Raspberry Pi OS):

sudo apt-get update
sudo apt-get install -y awscli pv lsof


If you want, I can also draft a short B2 Lifecycle Policy section for the docs (auto-delete after 3 days) using Backblaze’s web UI steps.
