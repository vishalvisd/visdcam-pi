# Rebuilding the Pi from scratch (USB flash drive) — visd-cctv end-to-end

* 2 ESP32-Cam MJPEG streams → Pi encodes to H.264 in MPEG-TS, segments to /mnt/ramcam (tmpfs)
* Uploaders push segments to Backblaze B2 via the S3-compatible endpoint (awscli v2)
* A tiny supervisor visdcam for common operations, including get/set segment duration
* A Day/Night preset timer calling the ESP endpoints at 06:00 and 18:00
* Wi-Fi disabled (Ethernet-only)
* Everything persists across reboots
Assumptions you can edit inline:
* User = visd
* Cameras: cam1=192.168.1.33, cam2=192.168.1.36
* B2 bucket = visd-cctv, region = ca-east-006 (endpoint https://s3.ca-east-006.backblazeb2.com)
* Default segment length = 20s (change later with visdcam setdur cam1 180, etc.)
* Upload throttle = 300 KiB/s per camera (change later in the unit files)

0) Base OS & quick checks (already booted from USB drive)

# Optional: set timezone for day/night timer
sudo timedatectl set-timezone Asia/Kolkata

# Verify versions (info only)
gst-launch-1.0 --version
aws --version

1) Packages

sudo apt-get update
sudo apt-get install -y \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  awscli pv lsof curl tzdata

2) RAM disk for segments

# Create and mount RAM area (1 GiB tmpfs)
sudo mkdir -p /mnt/ramcam/cam1 /mnt/ramcam/cam2
echo 'tmpfs /mnt/ramcam tmpfs defaults,size=1024m,noatime,mode=1777 0 0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount -a
sudo chown -R visd:visd /mnt/ramcam
df -h /mnt/ramcam

3) Backblaze B2 — awscli profile (b2)
3a) Credentials & config

mkdir -p ~/.aws

# Put your Backblaze Application Key ID / Key HERE
aws configure --profile b2
# AWS Access Key ID: 006xxxxxxxxxxxxx00000000YY
# AWS Secret Access Key: <your_app_key>
# Default region: (leave blank)
# Output: (leave blank)

# Minimal config for the b2 profile
cat > ~/.aws/config <<'CFG'
[profile b2]
region = ca-east-006
s3 =
    signature_version = s3v4
    addressing_style = virtual
CFG

# Sanity check: list buckets via the B2 S3 endpoint
AWS_PROFILE=b2 aws --endpoint-url https://s3.ca-east-006.backblazeb2.com s3 ls
You should see the bucket visd-cctv. If not, create it in the Backblaze UI and rerun the check.

4) Segmenter scripts (per camera)
These wrap the gst-launch-1.0 pipeline and read segment seconds from /etc/default/seg-cam{1,2}.

# cam1
sudo tee /usr/local/bin/seg-cam1.sh >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail
CAM_NAME="cam1"
CAM_IP="192.168.1.33"

# Defaults (overridable by /etc/default/seg-cam1)
FPS="${FPS:-15}"
BITRATE="${BITRATE:-1000}"            # kbps
SEGMENT_SEC="${SEGMENT_SEC:-20}"      # default 20s
OUTDIR="/mnt/ramcam/${CAM_NAME}"

# Compute duration in ns for splitmuxsink
DUR_NS=$(( SEGMENT_SEC * 1000000000 ))

exec /usr/bin/gst-launch-1.0 -e \
  souphttpsrc is-live=true location="http://${CAM_IP}/stream" do-timestamp=true ! \
  multipartdemux ! jpegdec ! \
  videorate drop-only=true max-rate=${FPS} ! \
  "video/x-raw,format=I420,framerate=${FPS}/1" ! \
  x264enc tune=zerolatency speed-preset=ultrafast bitrate=${BITRATE} key-int-max=$((FPS*3)) byte-stream=true threads=2 ! \
  h264parse config-interval=1 ! \
  "video/x-h264,stream-format=byte-stream,alignment=au" ! \
  splitmuxsink muxer-factory=mpegtsmux \
    location="${OUTDIR}/home-cam-1-%05d.ts" \
    max-size-time=${DUR_NS} \
    async-finalize=true
SH
sudo chmod +x /usr/local/bin/seg-cam1.sh

# cam2
sudo tee /usr/local/bin/seg-cam2.sh >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail
CAM_NAME="cam2"
CAM_IP="192.168.1.36"

FPS="${FPS:-15}"
BITRATE="${BITRATE:-1000}"
SEGMENT_SEC="${SEGMENT_SEC:-20}"
OUTDIR="/mnt/ramcam/${CAM_NAME}"

DUR_NS=$(( SEGMENT_SEC * 1000000000 ))

exec /usr/bin/gst-launch-1.0 -e \
  souphttpsrc is-live=true location="http://${CAM_IP}/stream" do-timestamp=true ! \
  multipartdemux ! jpegdec ! \
  videorate drop-only=true max-rate=${FPS} ! \
  "video/x-raw,format=I420,framerate=${FPS}/1" ! \
  x264enc tune=zerolatency speed-preset=ultrafast bitrate=${BITRATE} key-int-max=$((FPS*3)) byte-stream=true threads=2 ! \
  h264parse config-interval=1 ! \
  "video/x-h264,stream-format=byte-stream,alignment=au" ! \
  splitmuxsink muxer-factory=mpegtsmux \
    location="${OUTDIR}/home-cam-2-%05d.ts" \
    max-size-time=${DUR_NS} \
    async-finalize=true
SH
sudo chmod +x /usr/local/bin/seg-cam2.sh
4a) Per-cam environment files (default SEGMENT_SEC=20)

sudo tee /etc/default/seg-cam1 >/dev/null <<'ENV'
# Per-camera overrides for seg-cam1
SEGMENT_SEC=20
FPS=15
BITRATE=1000
ENV

sudo tee /etc/default/seg-cam2 >/dev/null <<'ENV'
# Per-camera overrides for seg-cam2
SEGMENT_SEC=20
FPS=15
BITRATE=1000
ENV

5) Segmenter systemd units

# cam1
sudo tee /etc/systemd/system/seg-cam1.service >/dev/null <<'UNIT'
[Unit]
Description=Segmenter cam1 (HTTP MJPEG -> x264 -> 20s TS to RAM)
After=network-online.target
Wants=network-online.target

[Service]
User=visd
Group=visd
Type=simple
EnvironmentFile=/etc/default/seg-cam1
ExecStartPre=/bin/mkdir -p /mnt/ramcam/cam1
ExecStartPre=/bin/sh -lc 'chown -R visd:visd /mnt/ramcam || true'
ExecStart=/usr/local/bin/seg-cam1.sh
Restart=always
RestartSec=2s

[Install]
WantedBy=multi-user.target
UNIT

# cam2
sudo tee /etc/systemd/system/seg-cam2.service >/dev/null <<'UNIT'
[Unit]
Description=Segmenter cam2 (HTTP MJPEG -> x264 -> 20s TS to RAM)
After=network-online.target
Wants=network-online.target

[Service]
User=visd
Group=visd
Type=simple
EnvironmentFile=/etc/default/seg-cam2
ExecStartPre=/bin/mkdir -p /mnt/ramcam/cam2
ExecStartPre=/bin/sh -lc 'chown -R visd:visd /mnt/ramcam || true'
ExecStart=/usr/local/bin/seg-cam2.sh
Restart=always
RestartSec=2s

[Install]
WantedBy=multi-user.target
UNIT

6) Uploaders (Backblaze B2 via awscli S3 endpoint)

# cam1
sudo tee /usr/local/bin/uploader-cam1.sh >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail

BUCKET="visd-cctv"
CAM="cam1"
RAMDIR="/mnt/ramcam/$CAM"

B2_PROFILE="${B2_PROFILE:-b2}"
B2_REGION="${B2_REGION:-ca-east-006}"
B2_ENDPOINT="${B2_ENDPOINT:-https://s3.${B2_REGION}.backblazeb2.com}"
RATE_KBPS="${RATE_KBPS:-300}"   # per-upload throttle (KiB/s)

log() { printf "[%(%F %T)T] %s: %s\n" -1 "$CAM" "$*"; }
log "uploader starting (pid=$$)"

while true; do
  shopt -s nullglob
  for f in "$RAMDIR"/*.ts "$RAMDIR"/*.mp4; do
    [ -e "$f" ] || continue

    # skip files still open or too fresh
    lsof -t -- "$f" >/dev/null 2>&1 && continue
    now=$(date +%s); mtime=$(stat -c %Y "$f")
    (( now - mtime < 5 )) && continue

    ext="${f##*.}"
    size="$(stat -c %s "$f")"
    epoch="$mtime"
    Y=$(TZ=Asia/Kolkata date -d "@$epoch" +%Y)
    M=$(TZ=Asia/Kolkata date -d "@$epoch" +%m)
    D=$(TZ=Asia/Kolkata date -d "@$epoch" +%d)
    h=$(TZ=Asia/Kolkata date -d "@$epoch" +%H)
    m=$(TZ=Asia/Kolkata date -d "@$epoch" +%M)
    s=$(TZ=Asia/Kolkata date -d "@$epoch" +%S)
    CAMNUM="${CAM#cam}"
    name="cam_${CAMNUM}_${Y}_${M}_${D}_${h}_${m}_${s}.${ext}"
    key="${CAM}/${Y}/${M}/${D}/${h}/${name}"

    log "upload start key=${key} size=${size}"
    if /usr/bin/pv -q -L "${RATE_KBPS}K" -- "$f" \
        | /usr/bin/aws --profile "$B2_PROFILE" --endpoint-url "$B2_ENDPOINT" \
            s3 cp --only-show-errors - "s3://${BUCKET}/${key}" --expected-size "$size"; then
      log "upload OK key=${key}"
    else
      log "upload FAIL key=${key}"
    fi

    # delete regardless of outcome (policy as agreed)
    rm -f -- "$f" || true
  done
  sleep 2
done
SH
sudo chmod +x /usr/local/bin/uploader-cam1.sh

# cam2
sudo tee /usr/local/bin/uploader-cam2.sh >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail

BUCKET="visd-cctv"
CAM="cam2"
RAMDIR="/mnt/ramcam/$CAM"

B2_PROFILE="${B2_PROFILE:-b2}"
B2_REGION="${B2_REGION:-ca-east-006}"
B2_ENDPOINT="${B2_ENDPOINT:-https://s3.${B2_REGION}.backblazeb2.com}"
RATE_KBPS="${RATE_KBPS:-300}"

log() { printf "[%(%F %T)T] %s: %s\n" -1 "$CAM" "$*"; }
log "uploader starting (pid=$$)"

while true; do
  shopt -s nullglob
  for f in "$RAMDIR"/*.ts "$RAMDIR"/*.mp4; do
    [ -e "$f" ] || continue
    lsof -t -- "$f" >/dev/null 2>&1 && continue
    now=$(date +%s); mtime=$(stat -c %Y "$f")
    (( now - mtime < 5 )) && continue

    ext="${f##*.}"
    size="$(stat -c %s "$f")"
    epoch="$mtime"
    Y=$(TZ=Asia/Kolkata date -d "@$epoch" +%Y)
    M=$(TZ=Asia/Kolkata date -d "@$epoch" +%m)
    D=$(TZ=Asia/Kolkata date -d "@$epoch" +%d)
    h=$(TZ=Asia/Kolkata date -d "@$epoch" +%H)
    m=$(TZ=Asia/Kolkata date -d "@$epoch" +%M)
    s=$(TZ=Asia/Kolkata date -d "@$epoch" +%S)
    CAMNUM="${CAM#cam}"
    name="cam_${CAMNUM}_${Y}_${M}_${D}_${h}_${m}_${s}.${ext}"
    key="${CAM}/${Y}/${M}/${D}/${h}/${name}"

    log "upload start key=${key} size=${size}"
    if /usr/bin/pv -q -L "${RATE_KBPS}K" -- "$f" \
        | /usr/bin/aws --profile "$B2_PROFILE" --endpoint-url "$B2_ENDPOINT" \
            s3 cp --only-show-errors - "s3://${BUCKET}/${key}" --expected-size "$size"; then
      log "upload OK key=${key}"
    else
      log "upload FAIL key=${key}"
    fi
    rm -f -- "$f" || true
  done
  sleep 2
done
SH
sudo chmod +x /usr/local/bin/uploader-cam2.sh
6a) Uploader units

sudo tee /etc/systemd/system/uploader-cam1.service >/dev/null <<'UNIT'
[Unit]
Description=Upload cam1 segments from RAM to B2 (delete even on failure)
After=network-online.target
Wants=network-online.target

[Service]
User=visd
Group=visd
Type=simple
RuntimeDirectory=visdcam
Environment=B2_PROFILE=b2
Environment=B2_REGION=ca-east-006
Environment=B2_ENDPOINT=https://s3.ca-east-006.backblazeb2.com
Environment=RATE_KBPS=300
ExecStart=/usr/local/bin/uploader-cam1.sh
Restart=always
RestartSec=2s
Nice=10

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/uploader-cam2.service >/dev/null <<'UNIT'
[Unit]
Description=Upload cam2 segments from RAM to B2 (delete even on failure)
After=network-online.target
Wants=network-online.target

[Service]
User=visd
Group=visd
Type=simple
RuntimeDirectory=visdcam
Environment=B2_PROFILE=b2
Environment=B2_REGION=ca-east-006
Environment=B2_ENDPOINT=https://s3.ca-east-006.backblazeb2.com
Environment=RATE_KBPS=300
ExecStart=/usr/local/bin/uploader-cam2.sh
Restart=always
RestartSec=2s
Nice=10

[Install]
WantedBy=multi-user.target
UNIT

7) Day/Night preset timer

# Script that calls ESP32-cam preset endpoints and logs responses
sudo tee /usr/local/bin/visdcam-daynight.sh >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail

# cams
C1="192.168.1.33"
C2="192.168.1.36"

hour=$(date +%H)
if (( hour >= 18 || hour < 6 )); then
  mode="night" ; why="hour=${hour} (>=18 or <6)"
else
  mode="day"   ; why="hour=${hour} (>=6 and <18)"
fi

log(){ printf "[%(%F %T)T] daynight: %s\n" -1 "$*"; }

for ip in "$C1" "$C2"; do
  log "Applying ${mode} preset to ${ip} because ${why}"
  resp=$(curl -sS --max-time 3 "http://${ip}:8080/${mode}" || true)
  log "Response from ${ip}: ${resp:-<no response>}"
done
SH
sudo chmod +x /usr/local/bin/visdcam-daynight.sh

# One-shot service
sudo tee /etc/systemd/system/visdcam-daynight.service >/dev/null <<'UNIT'
[Unit]
Description=Set ESP32-Cam day/night mode (calls both cams)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/visdcam-daynight.sh
UNIT

# Timer: run every day at 06:00 and 18:00
sudo tee /etc/systemd/system/visdcam-daynight.timer >/dev/null <<'UNIT'
[Unit]
Description=Schedule day/night preset calls (06:00, 18:00)

[Timer]
OnCalendar=*-*-* 06:00:00
OnCalendar=*-*-* 18:00:00
Persistent=true
Unit=visdcam-daynight.service

[Install]
WantedBy=timers.target
UNIT

8) visdcam helper (simple supervisor + duration get/set)

sudo tee /usr/local/bin/visdcam >/dev/null <<'PY'
#!/usr/bin/env python3
import argparse, subprocess, sys, os, re, time, urllib.request

CAMS = {
  "cam1": {
    "units": ["seg-cam1.service","uploader-cam1.service"],
    "url": "http://192.168.1.33/stream",
    "ramdir": "/mnt/ramcam/cam1",
    "seg_script": "/usr/local/bin/seg-cam1.sh",
    "envfile": "/etc/default/seg-cam1",
  },
  "cam2": {
    "units": ["seg-cam2.service","uploader-cam2.service"],
    "url": "http://192.168.1.36/stream",
    "ramdir": "/mnt/ramcam/cam2",
    "seg_script": "/usr/local/bin/seg-cam2.sh",
    "envfile": "/etc/default/seg-cam2",
  },
}
ALL_UNITS = [u for c in CAMS.values() for u in c["units"]]

def sh(cmd):
    print("$ " + " ".join(cmd))
    return subprocess.run(cmd, check=False).returncode

def units_for(target):
    if target == "all": return ALL_UNITS
    if target in CAMS:  return CAMS[target]["units"]
    if target.endswith(".service"): return [target]
    if target in [u.replace(".service","") for u in ALL_UNITS]:
        return [target + ".service"]
    sys.exit(f"Unknown target: {target}")

def cmd_start(a):  [sh(["systemctl","start",u])   for u in units_for(a.target)]
def cmd_stop(a):   [sh(["systemctl","stop",u])    for u in units_for(a.target)]
def cmd_restart(a):[sh(["systemctl","restart",u]) for u in units_for(a.target)]
def cmd_enable(a): [sh(["systemctl","enable",u])  for u in units_for(a.target)]
def cmd_disable(a):[sh(["systemctl","disable",u]) for u in units_for(a.target)]

def cmd_status(a):
    units = units_for(a.target) if a.target else ALL_UNITS
    sh(["systemctl","is-enabled",*units])
    sh(["systemctl","is-active",*units])
    for u in units:
        sh(["systemctl","status",u,"--no-pager","-l","-n","5"])

def cmd_logs(a):
    units = units_for(a.target)
    base = ["journalctl",*(sum([["-u",u] for u in units],[]))]
    if a.follow: base.append("-f")
    else: base += ["-n", str(a.lines)]
    base.append("--no-pager")
    sys.exit(subprocess.run(base).returncode)

def cmd_lsram(a):
    targets = ["cam1","cam2"] if a.target=="all" else [a.target]
    for t in targets:
        if t not in CAMS: sys.exit(f"Unknown cam: {t}")
        d = CAMS[t]["ramdir"]
        print(f"\n# {t}: {d}")
        sh(["bash","-lc",f"ls -lh {d} | tail -n +1 || true"])

def cmd_clean(a):
    targets = ["cam1","cam2"] if a.target=="all" else [a.target]
    for t in targets:
        if t not in CAMS: sys.exit(f"Unknown cam: {t}")
        d = CAMS[t]["ramdir"]
        sh(["bash","-lc",f"rm -f {d}/*.ts {d}/*.mp4 2>/dev/null || true"])

def read_envfile(path):
    m = {}
    if not os.path.exists(path): return m
    with open(path,"r") as f:
        for line in f:
            line=line.strip()
            if not line or line.startswith("#") or "=" not in line: continue
            k,v = line.split("=",1)
            m[k.strip()] = v.strip()
    return m

def write_envfile(path, kv):
    tmp = []
    seen = set()
    if os.path.exists(path):
        with open(path,"r") as f:
            for line in f:
                if "=" in line and not line.strip().startswith("#"):
                    k = line.split("=",1)[0].strip()
                    if k in kv:
                        tmp.append(f"{k}={kv[k]}\n"); seen.add(k); continue
                tmp.append(line)
    for k,v in kv.items():
        if k not in seen: tmp.append(f"{k}={v}\n")
    with open(path,"w") as f: f.writelines(tmp)

def cmd_getdur(a):
    if a.target not in CAMS: sys.exit("Use cam1 or cam2")
    env = read_envfile(CAMS[a.target]["envfile"])
    secs = int(env.get("SEGMENT_SEC","20"))
    print(secs)

def cmd_setdur(a):
    if a.target not in CAMS: sys.exit("Use cam1 or cam2")
    secs = str(int(a.seconds))
    envfile = CAMS[a.target]["envfile"]
    write_envfile(envfile, {"SEGMENT_SEC": secs})
    print(f"Updated {envfile} -> SEGMENT_SEC={secs}")
    seg_unit = [u for u in CAMS[a.target]["units"] if u.startswith("seg-")][0]
    sh(["systemctl","restart",seg_unit])

INFO_TEXT = """\
NAME
  visdcam — tiny supervisor for your two ESP32 cams on the Pi

GRAMMAR
  visdcam <verb> <target> [options]

TARGETS
  cam1, cam2, all
  (or explicit units like seg-cam1.service, uploader-cam2.service)

VERBS
  start|stop|restart <cam|all>         # control seg+uploader for that cam
  enable|disable <cam|all>             # toggle boot start
  status [cam|all]                     # show enabled/active + brief status
  logs <cam|unit> [--follow] [--lines N]
  lsram [cam|all]                      # list RAM files
  clean [cam|all]                      # rm RAM files
  getdur <cam>                         # print current segment seconds
  setdur <cam> <seconds>               # update /etc/default/seg-camX + restart seg
  info|actions                         # print this help

MAPPING
  cam1 → seg-cam1.service, uploader-cam1.service, http://192.168.1.33/stream, /mnt/ramcam/cam1
  cam2 → seg-cam2.service, uploader-cam2.service, http://192.168.1.36/stream, /mnt/ramcam/cam2
"""
def cmd_info(a): print(INFO_TEXT)

def main():
    p = argparse.ArgumentParser(add_help=False)
    sub = p.add_subparsers(dest="verb")

    for v in ["start","stop","restart","enable","disable"]:
        sp = sub.add_parser(v); sp.add_argument("target"); sp.set_defaults(func=globals()[f"cmd_{v}"])

    sp = sub.add_parser("status"); sp.add_argument("target", nargs="?"); sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("logs")
    sp.add_argument("target"); sp.add_argument("--follow", action="store_true")
    sp.add_argument("--lines", type=int, default=200); sp.set_defaults(func=cmd_logs)

    sp = sub.add_parser("lsram"); sp.add_argument("target", nargs="?", default="all"); sp.set_defaults(func=cmd_lsram)
    sp = sub.add_parser("clean"); sp.add_argument("target", nargs="?", default="all"); sp.set_defaults(func=cmd_clean)

    sp = sub.add_parser("getdur"); sp.add_argument("target"); sp.set_defaults(func=cmd_getdur)
    sp = sub.add_parser("setdur"); sp.add_argument("target"); sp.add_argument("seconds"); sp.set_defaults(func=cmd_setdur)

    for v in ["info","actions","--info","-h","--help"]:
        sub.add_parser(v).set_defaults(func=cmd_info)

    args, extra = p.parse_known_args()
    if not args.verb:
        cmd_info(args); sys.exit(0)
    args.func(args)

if __name__ == "__main__":
    main()
PY
sudo chmod +x /usr/local/bin/visdcam

9) Enable everything & start

sudo systemctl daemon-reload
sudo systemctl enable --now seg-cam1.service seg-cam2.service
sudo systemctl enable --now uploader-cam1.service uploader-cam2.service
sudo systemctl enable --now visdcam-daynight.timer

# Quick health
visdcam status
watch -n2 'visdcam lsram'
(Note) Segments will be ~20s by default. Change any time:

sudo visdcam setdur cam1 180
sudo visdcam setdur cam2 180
sudo visdcam getdur cam1

10) Ethernet-only (disable Wi-Fi permanently)

# Disable radio in firmware
sudo sed -i '/^dtoverlay=disable-wifi$/d' /boot/firmware/config.txt
echo 'dtoverlay=disable-wifi' | sudo tee -a /boot/firmware/config.txt

# Stop and mask supplicant
sudo systemctl disable --now wpa_supplicant.service wpa_supplicant@wlan0.service || true
sudo systemctl mask wpa_supplicant.service wpa_supplicant@wlan0.service

sudo reboot
After reboot:

ip route show default     # should show ONLY via eth0
ip link | grep -E 'wlan|wl' || echo "No Wi-Fi interfaces present ✓"

11) Backblaze housekeeping (UI)
In the Backblaze web UI for bucket visd-cctv:
* Lifecycle: set “Keep only the last 3 days of versions” (or an equivalent rule deleting files older than 3 days).
* CORS (not required for this pipeline).
* Public/Private: keep Private; uploads use the b2 profile.

12) Handy commands

# Start/Stop/Restart all cam units
sudo visdcam stop all
sudo visdcam start all
sudo visdcam restart cam1

# Logs
journalctl -u seg-cam1.service -n 50 --no-pager
journalctl -u uploader-cam1.service -n 50 --no-pager

# Verify B2 uploads
AWS_PROFILE=b2 aws --endpoint-url https://s3.ca-east-006.backblazeb2.com s3 ls s3://visd-cctv/cam1/$(date +%Y)/

# Day/Night manual run
sudo systemctl start visdcam-daynight.service
journalctl -u visdcam-daynight.service -n 20 --no-pager

That’s it
With this document you can rebuild the Pi from a blank drive to the exact final working state we had, including Backblaze B2 uploads, RAM-only writes, day/night presets, Ethernet-only networking, and an operator utility to tweak segment length on the fly.



