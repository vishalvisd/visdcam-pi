#!/usr/bin/env bash
set -euo pipefail
export TZ=Asia/Kolkata

log(){ echo "[$(date '+%F %T')] $*"; }

for c in cam1 cam2; do
  ip="192.168.1.$([ "$c" = cam1 ] && echo 33 || echo 36)"
  hour=$(date +%H)
  if [ "$hour" -ge 18 ] || [ "$hour" -lt 6 ]; then
    log "$c: Applying night preset (hour=$hour)"
    resp=$(curl -sS --max-time 3 "http://$ip:8080/night" || true)
    log "$c: Response night: ${resp:-<no response>}"
  else
    log "$c: Applying day preset (hour=$hour)"
    resp=$(curl -sS --max-time 3 "http://$ip:8080/day" || true)
    log "$c: Response day: ${resp:-<no response>}"
  fi
done
