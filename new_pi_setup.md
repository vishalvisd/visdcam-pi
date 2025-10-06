Fresh Pi bootstrap — packages & quick setup for visdcam

Use this when you bring up a brand-new Raspberry Pi OS Lite (64-bit) box.

1) Update base system
sudo apt-get update
sudo apt-get -y full-upgrade
sudo reboot

2) Install required tools (minimal)
sudo apt-get install -y \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
  awscli \
  python3 python3-pip \
  curl ca-certificates tzdata \
  git
# Optional (handy for debug):
# sudo apt-get install -y v4l-utils htop iotop


Why these:

GStreamer: gst-launch-1.0, souphttpsrc, jpegdec, x264enc, splitmuxsink, mp4mux.

awscli: S3 uploads.

python3/pip: the visdcam helper CLI.

curl/ca-certificates/tzdata: networking, TLS, correct time.

git: pull your repo/scripts.

Verify key plugins:

gst-inspect-1.0 x264enc | head -n1
gst-inspect-1.0 souphttpsrc | head -n1
gst-inspect-1.0 splitmuxsink | head -n1
gst-inspect-1.0 mp4mux | head -n1

3) Correct timezone & time sync
sudo timedatectl set-timezone Asia/Kolkata
timedatectl status    # NTP should be "active: yes"


Accurate time avoids auth issues with AWS.

4) RAM disk mount (clips buffer)

Add to /etc/fstab:

tmpfs  /mnt/ramcam  tmpfs  rw,nosuid,nodev,noatime,size=768M,mode=0755  0  0


Then:

sudo mkdir -p /mnt/ramcam
sudo mount -a


Auto-create camera dirs at boot:

sudo tee /etc/tmpfiles.d/ramcam.conf >/dev/null <<'EOF'
D /mnt/ramcam 0755 root root -
d /mnt/ramcam/cam1 0755 visd visd -
d /mnt/ramcam/cam2 0755 visd visd -
EOF
sudo systemd-tmpfiles --create /etc/tmpfiles.d/ramcam.conf

5) AWS credentials (once per Pi)

Install was done above; now configure creds for user visd (uploads run as this user).
See your “AWS Credentials Setup for visdcam” doc, or quick version:

sudo -u visd mkdir -p /home/visd/.aws
sudo -u visd bash -c 'cat > /home/visd/.aws/credentials <<EOF
[default]
aws_access_key_id=REPLACE_ME
aws_secret_access_key=REPLACE_ME
EOF'
sudo -u visd bash -c 'cat > /home/visd/.aws/config <<EOF
[default]
region=ap-south-1
output=json
EOF'
sudo chown -R visd:visd /home/visd/.aws
chmod 600 /home/visd/.aws/credentials /home/visd/.aws/config
sudo -u visd aws sts get-caller-identity

6) Install the visdcam helper CLI
sudo tee /usr/local/bin/visdcam >/dev/null <<'EOF'
#!/usr/bin/env python3
import sys,subprocess
USAGE="""visdcam <command> [target]
Targets: cam1, cam2, all, seg-cam1, seg-cam2, uploader-cam1, uploader-cam2
Commands:
  start|stop|restart [target]     Control services
  status [target]                 Show systemd status
  tail [target]                   Tail logs (Ctrl-C to stop)
  health                          One-shot health snapshot
  list                            List unit names
  --info                          Show this help
"""
UNITS={'cam1':['seg-cam1.service','uploader-cam1.service'],
       'cam2':['seg-cam2.service','uploader-cam2.service'],
       'all':['seg-cam1.service','uploader-cam1.service','seg-cam2.service','uploader-cam2.service']}

def expand(t):
    if t in UNITS: return UNITS[t]
    if t.endswith('.service'): return [t]
    return [f'seg-{t}.service'] if t.startswith('seg-') else [f'uploader-{t}.service'] if t.startswith('uploader-') else []

def run(cmd): subprocess.run(cmd, check=False)

def health():
    run(["/usr/local/bin/cctv-health-snap.sh"])

def main():
    if len(sys.argv)<2 or sys.argv[1] in ("--info","help","-h"):
        print(USAGE); return
    cmd=sys.argv[1]; tgt=sys.argv[2] if len(sys.argv)>2 else 'all'
    units=expand(tgt) or (UNITS['all'] if tgt=='all' else [])
    if not units: print(USAGE); return
    if cmd in ('start','stop','restart','status'):
        run(['systemctl',cmd,*units])
    elif cmd=='tail':
        run(['journalctl','-u',*units,'-f'])
    elif cmd=='list':
        print('\n'.join(UNITS['all']))
    elif cmd=='health':
        health()
    else:
        print(USAGE)
if __name__=="__main__": main()
EOF
sudo chmod +x /usr/local/bin/visdcam


(If you use the health snapshot, ensure /usr/local/bin/cctv-health-snap.sh exists as in your repo.)

7) Restore/create services & scripts

Place your four unit files and two segmenter/uploader scripts as in your repo:

/usr/local/bin/seg-cam1.sh, /usr/local/bin/seg-cam2.sh

/usr/local/bin/uploader-cam1.sh, /usr/local/bin/uploader-cam2.sh

/etc/systemd/system/seg-cam1.service, /etc/systemd/system/seg-cam2.service

/etc/systemd/system/uploader-cam1.service, /etc/systemd/system/uploader-cam2.service

Then:

sudo chmod +x /usr/local/bin/seg-cam*.sh /usr/local/bin/uploader-cam*.sh
sudo systemctl daemon-reload
sudo systemctl enable --now seg-cam1.service uploader-cam1.service seg-cam2.service uploader-cam2.service

8) Sanity checks
visdcam status
sleep 10
visdcam health
sudo -u visd aws s3 ls s3://<your-bucket>/cam1/
sudo -u visd aws s3 ls s3://<your-bucket>/cam2/


If you need to control quickly:

visdcam stop cam1
visdcam start cam1
visdcam tail cam2
