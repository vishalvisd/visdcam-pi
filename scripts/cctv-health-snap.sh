#!/usr/bin/env bash
set -euo pipefail
echo "=== Time ==="; date
echo "=== Uptime/Load ==="; uptime
echo "=== Temp/Throttle ==="; vcgencmd measure_temp || true; vcgencmd get_throttled || true
echo "=== Services ==="; systemctl --no-pager --type=service --state=active | egrep 'seg-cam|uploader-cam' || true
echo "=== gst-launch CPU/MEM ==="; ps -C gst-launch-1.0 -o pid,pcpu,pmem,etime,cmd --sort=-pcpu
echo "=== aws cli (uploader) CPU/MEM ==="; pgrep -af 'aws s3 cp' | sed 's/^/  /' || echo "  (idle)"
echo "=== Memory ==="; free -h
echo "=== RAM disk ==="; df -h /mnt/ramcam
