# Rebuilding the Pi from scratch (USB flash drive) — **visd-cctv** end-to-end

This is a single, copy-paste friendly runbook to recreate the exact working setup we finished with:

* 2 ESP32-Cam MJPEG streams → Pi encodes to **H.264 in MPEG-TS**, segments to **/mnt/ramcam** (tmpfs)
    
* Uploaders push segments to **Backblaze B2** via the S3-compatible endpoint (awscli v2)
    
* A tiny supervisor `visdcam` for common operations, including **get/set segment duration**
    
* A **Day/Night preset** timer calling the ESP endpoints at **06:00** and **18:00**
    
* **Wi-Fi disabled** (Ethernet-only)
    
* Everything **persists across reboots**
    

Assumptions you can edit inline:

* **User** = `visd`
    
* **Cameras**: `cam1=192.168.1.33`, `cam2=192.168.1.36`
    
* **B2 bucket** = `visd-cctv`, **region** = `ca-east-006` (endpoint `https://s3.ca-east-006.backblazeb2.com`)
    
* **Default segment length** = **20s** (change later with `visdcam setdur cam1 180`, etc.)
    
* **Upload throttle** = **300 KiB/s per camera** (change later in the unit files)
    

* * *

## 0) Base OS & quick checks (already booted from USB drive)

```bash
# Optional: set timezone for day/night timer
sudo timedatectl set-timezone Asia/Kolkata

# Verify versions (info only)
gst-launch-1.0 --version
aws --version
```

* * *

## 1) Packages

```bash
sudo apt-get update
sudo apt-get install -y \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  awscli pv lsof curl tzdata
```

* * *

## 2) RAM disk for segments

```bash
# Create and mount RAM area (1 GiB tmpfs)
sudo mkdir -p /mnt/ramcam/cam1 /mnt/ramcam/cam2
echo 'tmpfs /mnt/ramcam tmpfs defaults,size=1024m,noatime,mode=1777 0 0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount -a
sudo chown -R visd:visd /mnt/ramcam
df -h /mnt/ramcam
```

* * *

## 3) Backblaze B2 — awscli profile (`b2`)

### 3a) Credentials & config

```bash
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
```

You should see the bucket `visd-cctv`. If not, create it in the Backblaze UI and rerun the check.

* * *

## 4) Segmenter scripts (per camera)

These wrap the `gst-launch-1.0` pipeline and read **segment seconds** from `/etc/default/seg-cam{1,2}`.

```bash
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
```

### 4a) Per-cam environment files (default SEGMENT_SEC=20)

```bash
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
```

* * *

## 5) Segmenter systemd units

```bash
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
```

* * *

## 6) Uploaders (Backblaze B2 via awscli S3 endpoint)

```bash
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
```

### 6a) Uploader units

```bash
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
```

* * *

## 7) Day/Night preset timer

```bash
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
```

* * *

## 8) `visdcam` helper (simple supervisor + duration get/set)

```bash
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
```

* * *

## 9) Enable everything & start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now seg-cam1.service seg-cam2.service
sudo systemctl enable --now uploader-cam1.service uploader-cam2.service
sudo systemctl enable --now visdcam-daynight.timer

# Quick health
visdcam status
watch -n2 'visdcam lsram'
```

(**Note**) Segments will be **~20s** by default. Change any time:

```bash
sudo visdcam setdur cam1 180
sudo visdcam setdur cam2 180
sudo visdcam getdur cam1
```

* * *

## 10) Ethernet-only (disable Wi-Fi permanently)

```bash
# Disable radio in firmware
sudo sed -i '/^dtoverlay=disable-wifi$/d' /boot/firmware/config.txt
echo 'dtoverlay=disable-wifi' | sudo tee -a /boot/firmware/config.txt

# Stop and mask supplicant
sudo systemctl disable --now wpa_supplicant.service wpa_supplicant@wlan0.service || true
sudo systemctl mask wpa_supplicant.service wpa_supplicant@wlan0.service

sudo reboot
```

After reboot:

```bash
ip route show default     # should show ONLY via eth0
ip link | grep -E 'wlan|wl' || echo "No Wi-Fi interfaces present ✓"
```

* * *

## 11) Backblaze housekeeping (UI)

In the Backblaze web UI for bucket **visd-cctv**:

* **Lifecycle**: set “Keep only the last **3 days** of versions” (or an equivalent rule deleting files older than 3 days).
    
* **CORS** (not required for this pipeline).
    
* **Public/Private**: keep **Private**; uploads use the `b2` profile.
    

* * *

## 12) Handy commands

```bash
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
```

* * *

### That’s it

# Make sure PI is only consuming RAM and not storage :-


## Confirm segments go to RAM (tmpfs)
```
mount | grep '/mnt/ramcam'            # should show type tmpfs
df -h /mnt/ramcam
systemctl status seg-cam1.service --no-pager -l | grep -A1 'splitmuxsink'
systemctl status seg-cam2.service --no-pager -l | grep -A1 'splitmuxsink'
# location= must point to /mnt/ramcam/cam1 and /mnt/ramcam/cam2

```

## Make all system logs volatile (RAM)
```
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/volatile.conf >/dev/null <<'CFG'
[Journal]
Storage=volatile
RuntimeMaxUse=64M
CFG

# Optional: ensure no persistent journal dir remains
sudo rm -rf /var/log/journal

sudo systemctl restart systemd-journald
# Verify journal now lives in RAM
mount | grep '/run/log/journal'

```

## Mount /tmp in RAM (tmpfs)
```
sudo systemctl enable --now tmp.mount
mount | grep ' on /tmp '   # should show type tmpfs

```

## Double-check our units don’t write to disk
```
# Should NOT contain any "StandardOutput=append:/path" etc.
systemctl cat uploader-cam1.service | sed -n '1,200p'
systemctl cat uploader-cam2.service | sed -n '1,200p'
systemctl cat seg-cam1.service | sed -n '1,200p'
systemctl cat seg-cam2.service | sed -n '1,200p'

```

## Runtime verification: watch disk writes
```
# Monitor sectors written on your root device (likely sda). MB/s should stay ~0.
DEV=sda
bash -lc '
prev=$(awk -v d="'$DEV'" "$3==d{print \$8}" /proc/diskstats)
while sleep 1; do
  now=$(awk -v d="'$DEV'" "$3==d{print \$8}" /proc/diskstats)
  mbps=$(awk -v n=$now -v p=$prev "BEGIN{print (n-p)*512/1024/1024}")
  printf "disk %-4s writes: %+8.3f MB/s (sectors delta: %d)\n" "'$DEV'" "$mbps" "$((now-prev))"
  prev=$now
done'

```

## Quick spot checks for accidental disk writes
```
# Any files in /var/log touched in last 5 min? (should be empty or very few)
sudo find /var/log -type f -mmin -5 -ls

# Any open files under /var/log by our services? (ideally none)
sudo lsof +D /var/log 2>/dev/null | egrep 'seg-cam|uploader-cam' || echo "OK: no cam processes writing under /var/log"

```


## Reboot & re-verify
```
sudo reboot
# after boot:
mount | egrep '/mnt/ramcam|/tmp|/run/log/journal'
visdcam status

```


# visdauto
## watering

### scripts live at `/home/visd/workspace/RelayController/src`.



# visdauto — simple home-automation runner (watering @ 7 AM IST)

This folder documents how to (re)create the **visdauto** tooling on a fresh Pi so it can run your relay script every morning at 07:00 IST, and let you trigger/stop it on demand. All logs are written to RAM (tmpfs) to avoid SD-card wear.

## What it does

* Runs `PanelCleanerAndPlantsWatering.py` **every day at 07:00 IST** (no catch-up if the Pi was off).
    
* Lets you **start/stop** the job manually.
    
* Logs to **/run/visdauto/watering.log** (in RAM; cleared on reboot).
    
* Keeps this automation **separate from visdcam**.
    

* * *

## Prerequisites (checklist)

* User: `visd` exists and owns your code directory.
    
* Timezone is IST:
    

```bash
timedatectl | grep 'Time zone'
# If needed:
sudo timedatectl set-timezone Asia/Kolkata
```

* Python present at `/usr/bin/python3`:
    

```bash
command -v /usr/bin/python3
# If missing:
sudo apt-get update && sudo apt-get install -y python3
```

* Your scripts are present:
    

```
/home/visd/workspace/RelayController/src/PanelCleanerAndPlantsWatering.py
/home/visd/workspace/RelayController/src/GracefullyStopPanelCleanerAndPlantsWatering.py
```

> Note: they do **not** need to be executable; systemd calls them via `/usr/bin/python3 -u`.

* * *

## Install steps (copy-paste)

### 1) Create the `visdauto` CLI

```bash
sudo tee /usr/local/bin/visdauto >/dev/null <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
visdauto watering enable        # enable 7:00 IST daily schedule
visdauto watering disable       # disable schedule
visdauto watering run           # run now (foreground via systemd oneshot)
visdauto watering stoprun       # run the graceful stop script now
visdauto watering status        # show unit + timer status
visdauto watering logs          # tail recent RAM logs
visdauto watering clearlogs     # truncate RAM log file
USAGE
}

[[ $# -lt 2 || "$1" != "watering" ]] && { usage; exit 1; }
cmd="$2"

case "$cmd" in
  enable)    sudo systemctl enable --now watering.timer ;;
  disable)   sudo systemctl disable --now watering.timer ;;
  run)       sudo systemctl start watering.service ;;
  stoprun)   sudo systemctl start watering-stop.service ;;
  status)
    systemctl status watering.service --no-pager -l -n 5 || true
    echo
    systemctl status watering.timer   --no-pager -l -n 5 || true
    ;;
  logs)      sudo bash -lc '[[ -f /run/visdauto/watering.log ]] && tail -n 200 /run/visdauto/watering.log || echo "no logs yet"' ;;
  clearlogs) sudo bash -lc ': >/run/visdauto/watering.log || echo "no log file to clear (it lives in RAM)"' ;;
  *) usage; exit 1 ;;
esac
BASH
sudo chmod +x /usr/local/bin/visdauto
```

### 2) Create systemd units (service + timer)

```bash
# watering.service — runs your main script; logs appended to /run/visdauto/watering.log
sudo tee /etc/systemd/system/watering.service >/dev/null <<'INI'
[Unit]
Description=VISD Auto - Watering (runs your PanelCleanerAndPlantsWatering.py)

[Service]
Type=oneshot
User=visd
Group=visd
WorkingDirectory=/home/visd/workspace/RelayController/src
Environment=PYTHONUNBUFFERED=1
# systemd creates /run/visdauto (owned by visd) before ExecStart
RuntimeDirectory=visdauto
# up to 15 minutes for the run
TimeoutStartSec=900
# append stdout+stderr to RAM log
ExecStart=/bin/bash -lc 'exec /usr/bin/python3 -u "/home/visd/workspace/RelayController/src/PanelCleanerAndPlantsWatering.py" >>/run/visdauto/watering.log 2>&1'
INI

# watering-stop.service — triggers your graceful stop script; logs to same file
sudo tee /etc/systemd/system/watering-stop.service >/dev/null <<'INI'
[Unit]
Description=VISD Auto - Watering STOP (graceful)

[Service]
Type=oneshot
User=visd
Group=visd
WorkingDirectory=/home/visd/workspace/RelayController/src
Environment=PYTHONUNBUFFERED=1
RuntimeDirectory=visdauto
TimeoutStartSec=300
ExecStart=/bin/bash -lc 'exec /usr/bin/python3 -u "/home/visd/workspace/RelayController/src/GracefullyStopPanelCleanerAndPlantsWatering.py" >>/run/visdauto/watering.log 2>&1'
INI

# watering.timer — fire daily at 07:00 IST; no catch-up if missed
sudo tee /etc/systemd/system/watering.timer >/dev/null <<'INI'
[Unit]
Description=VISD Auto - Watering daily 07:00 IST

[Timer]
OnCalendar=*-*-* 07:00:00
# If Pi was off at 07:00, do not run on boot
Persistent=false
Unit=watering.service

[Install]
WantedBy=timers.target
INI

# load everything
sudo systemctl daemon-reload
```

* * *

## First run & enable schedule

```bash
# test one manual run
visdauto watering run
# see live logs (RAM)
visdauto watering logs

# enable the 7AM schedule
visdauto watering enable
# confirm the timer
systemctl list-timers --all | grep watering
```

* * *

## Day-to-day commands

```bash
visdauto watering status     # see last run, next run, and unit state
visdauto watering logs       # tail recent logs from /run/visdauto/watering.log
visdauto watering clearlogs  # truncate RAM log file
visdauto watering run        # run now
visdauto watering stoprun    # trigger graceful stop now
visdauto watering disable    # stop daily schedule
visdauto watering enable     # re-enable daily schedule
```

* * *

## Change the schedule (e.g., 06:30 IST)

```bash
sudo systemctl edit watering.timer
# paste:
# [Timer]
# OnCalendar=*-*-* 06:30:00
# (save + exit)
sudo systemctl daemon-reload
sudo systemctl restart watering.timer
visdauto watering status
```

* * *

## Troubleshooting

* **No logs?** The file lives in RAM and is created on first run: `/run/visdauto/watering.log`.  
    Run once: `visdauto watering run`, then `visdauto watering logs`.
    
* **Service fails immediately**
    
    * Check Python path: `command -v /usr/bin/python3`.
        
    * Check permissions/paths:
        
        * Working dir: `/home/visd/workspace/RelayController/src`
            
        * Script: `PanelCleanerAndPlantsWatering.py` (exact name).
            
    * Inspect detailed logs:
        
        ```bash
        systemctl status watering.service --no-pager -l
        journalctl -u watering.service -n 100 --no-pager
        ```
        
* **Timer didn’t run**
    
    * Confirm timezone is IST: `timedatectl`.
        
    * Check timer state:
        
        ```bash
        systemctl status watering.timer --no-pager -l
        systemctl list-timers --all | grep watering
        ```
        
* **Logs persist across reboots?** No. They’re on `/run` (tmpfs) by design to protect the SD card.
    

* * *

## Uninstall

```bash
visdauto watering disable
sudo rm -f /etc/systemd/system/watering.service \
           /etc/systemd/system/watering-stop.service \
           /etc/systemd/system/watering.timer
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/visdauto
```


# Tailscale

# 1) Install & start Tailscale on the Pi

```bash
# Install
curl -fsSL https://tailscale.com/install.sh | sh

# Ensure the daemon runs on boot and start it now
sudo systemctl enable --now tailscaled

# Bring the node onto your tailnet (opens a URL you approve in any browser)
sudo tailscale up --hostname=visdpi
```

After you approve the device, verify:

```bash
tailscale status
tailscale ip -4   # note the Tailscale IPv4 (e.g., 100.x.y.z)
```

# 2) Keep logs RAM-only (journald volatile mode)

(You likely already have this, but here are the checks.)

```bash
# See current mode: "Storage=volatile" means RAM-only
grep -E '^[# ]*Storage=' /etc/systemd/journald.conf || true
systemctl status systemd-journald -n 0 --no-pager

# If NOT volatile, make it so:
sudo sed -i 's/^[# ]*Storage=.*/Storage=volatile/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

Tailscale logs will live in RAM (journald), and vanish on reboot—no SD wear.

# 3) Make sure OpenSSH server is running

(We’re using your current SSH, not “Tailscale SSH”.)

```bash
# Install if missing
sudo apt-get update
sudo apt-get install -y openssh-server

# Enable & start
sudo systemctl enable --now ssh

# Quick check
systemctl is-active ssh && echo "sshd is running"
```

# 4) Connect from your Mac

* Install the Tailscale app on macOS (from App Store or `brew install --cask tailscale`), log into the same account.
    
* In a Terminal:
    
    ```bash
    # Use the 100.x.y.z you saw on the Pi:
    ssh visd@100.x.y.z
    ```
    
    If you enable **MagicDNS** in the Tailscale admin later, you can also do:
    
    ```bash
    ssh visd@visdpi   # or visdpi.tailnet-<something>.ts.net
    ```
    

# 5) Nothing else changes for your workloads

* No router/port-forward changes needed.
    
* No traffic shaping or routing is altered for your cams/uploads.
    
* Tailscale is idle ~0–1% CPU and ~40–80 MB RAM—well within your budget.
    

# 6) Useful admin commands (safe to use anytime)

```bash
# See who’s connected / device’s IPs
tailscale status
tailscale ip -4

# Temporarily stop or start the agent
sudo systemctl stop tailscaled
sudo systemctl start tailscaled

# Disconnect the device from your tailnet (you’ll need to re-auth)
sudo tailscale logout
```

# 7) Optional “belt & suspenders” (don’t change unless you want to)

If you want to be explicit that this node **won’t** act as exit node or advertise routes:

```bash
sudo tailscale up --hostname=visdpi --advertise-exit-node=false --accept-routes=false
```

(That’s the default behavior, but this makes it obvious.)

* * *

### FAQs you might ask me later

* **Can I still `sudo` after SSH’ing via Tailscale?** Yes—same as local LAN SSH.
    
* **Will Tailscale fill my SD with logs?** No—journald is volatile; logs stay in RAM.
    
* **What if I forget the IP?** `tailscale ip -4` on the Pi, or see the device in the Tailscale admin, or enable MagicDNS and use `ssh visd@visdpi`.
    

If you want to flip to “Tailscale SSH” later (and disable local sshd), I’ll give you a tiny ACL snippet and one `tailscale up --ssh` command.

* * *


# Enable “web SSH” to the Pi
1. In the Tailscale admin → **Access controls (ACLs)**, make sure you have something like:
    

```json
{
  "tagOwners": {
    "tag:pi": ["you@your-email.com"]   // your Tailscale login
  },
  "ssh": [
    {
      "action": "accept",
      "src": ["autogroup:members"],
      "dst": ["tag:pi"],
      "users": ["visd"]
    }
  ]
}
```

2. **Turn on Tailscale SSH on the Pi**  
    (run once; it keeps journald-only logging as you already set)
    

```bash
sudo tailscale up --ssh --hostname=visdpi --advertise-tags=tag:visdpi
```
