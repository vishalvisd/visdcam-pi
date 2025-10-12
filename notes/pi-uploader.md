Log files: /run/visdcam/uploader-cam1.log, /run/visdcam/uploader-cam2.log

Tune per-camera throttle (optional):

# /etc/default/uploader-cam1
RATE_KBPS=500

# /etc/default/uploader-cam2
RATE_KBPS=500


Enable/start:

sudo systemctl daemon-reload
sudo systemctl enable --now uploader-cam1.service uploader-cam2.service