#!/usr/bin/env bash
set -euo pipefail
export TZ=Asia/Kolkata

/usr/bin/gst-launch-1.0 -e \
  souphttpsrc is-live=true location=http://192.168.1.33/stream do-timestamp=true ! \
  multipartdemux ! \
  jpegdec ! \
  videorate drop-only=true max-rate=15 ! \
  video/x-raw,format=I420,framerate=15/1 ! \
  x264enc tune=zerolatency speed-preset=ultrafast bitrate=1000 key-int-max=45 byte-stream=true threads=2 ! \
  h264parse config-interval=1 ! \
  video/x-h264,stream-format=byte-stream,alignment=au ! \
  splitmuxsink muxer-factory=mpegtsmux \
    location=/mnt/ramcam/cam1/home-cam-1-%05d.ts \
    max-size-time=180000000000 \
    async-finalize=true
