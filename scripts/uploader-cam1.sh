#!/usr/bin/env bash
set -euo pipefail

B2_PROFILE=b2
B2_REGION=ca-east-006
B2_ENDPOINT="https://s3.${B2_REGION}.backblazeb2.com"

BUCKET="visd-cctv"
CAM="cam1"
RAMDIR="/mnt/ramcam/$CAM"

# --- RAM logging (no SD writes) ---
mkdir -p /run/visdcam
exec >>/run/visdcam/uploader-cam1.log 2>&1
echo "[$(date '+%F %T')] ${CAM}: uploader starting (pid=$$)"

# Optional per-cam overrides
[ -f /etc/default/uploader-$CAM ] && . /etc/default/uploader-$CAM
RATE_KBPS="${RATE_KBPS:-300}"   # throttle per upload (KiB/s)

log(){ printf '[%(%F %T)T] %s: %s\n' -1 "$CAM" "$*"; }

while true; do
  shopt -s nullglob
  for f in "$RAMDIR"/*.ts "$RAMDIR"/*.mp4; do
    [ -e "$f" ] || continue

    # skip if still open or too fresh
    if lsof -t -- "$f" >/dev/null 2>&1; then continue; fi
    now=$(date +%s); mtime=$(stat -c %Y "$f")
    if (( now - mtime < 5 )); then continue; fi

    ext="${f##*.}"; size="$(stat -c %s "$f")"; epoch="$mtime"
    Y=$(TZ=Asia/Kolkata date -d "@$epoch" +%Y)
    M=$(TZ=Asia/Kolkata date -d "@$epoch" +%m)
    D=$(TZ=Asia/Kolkata date -d "@$epoch" +%d)
    h=$(TZ=Asia/Kolkata date -d "@$epoch" +%H)
    m=$(TZ=Asia/Kolkata date -d "@$epoch" +%M)
    s=$(TZ=Asia/Kolkata date -d "@$epoch" +%S)
    CAMNUM="${CAM#cam}"
    name="cam_${CAMNUM}_${Y}_${M}_${D}_${h}_${m}_${s}.${ext}"
    key="${CAM}/${Y}/${M}/${D}/${h}/${name}"
    dest="s3://${BUCKET}/${key}"

    log "upload start key=${key} size=${size}"
    if /usr/bin/pv -q -L "${RATE_KBPS}K" -- "$f" \
        | /usr/bin/aws --profile "$B2_PROFILE" --endpoint-url "$B2_ENDPOINT" \
            s3 cp --only-show-errors - "$dest" --expected-size "$size"; then
      log "upload OK key=${key}"
    else
      log "upload FAIL key=${key}"
    fi
    rm -f -- "$f" || true   # policy: delete even on failure
  done
  sleep 2
done
