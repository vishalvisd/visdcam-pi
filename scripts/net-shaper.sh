#!/usr/bin/env bash
set -euo pipefail
IF=eth0
RATE="3mbit"    # adjust here
BURST="32kbit"
LAT="50ms"

/sbin/tc qdisc del dev "$IF" root 2>/dev/null || true
/sbin/tc qdisc add dev "$IF" root tbf rate "$RATE" burst "$BURST" latency "$LAT"
