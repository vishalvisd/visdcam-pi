#!/usr/bin/env bash
set -euo pipefail
export TZ=Asia/Kolkata
ROOT=/mnt/ramcam/cam2
BUCKET=visd-cctv
while sleep 2; do
  shopt -s nullglob
  for f in "$ROOT"/*.ts; do
    lsof "$f" >/dev/null 2>&1 && continue
    ts_utc=$(stat -c %Y "$f")
    ts=$(date -d @"$ts_utc" +%Y_%m_%d_%H_%M_%S)
    new="$ROOT/cam_2_${ts}.ts"
    mv -f "$f" "$new"
    # S3 path: cam2/YYYY/MM/DD/HH/
    aws s3 cp --only-show-errors "$new" \
      "s3://$BUCKET/cam2/${ts:0:4}/${ts:5:2}/${ts:8:2}/${ts:11:2}/"
    rm -f "$new"
  done
done
