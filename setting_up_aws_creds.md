AWS Credentials Setup for visdcam on a fresh Raspberry Pi

This guide shows how to create least-privilege AWS credentials and wire them so the visdcam services (segmenters + S3 uploaders) can upload clips.

Prereqs

You have your S3 bucket created (example in this doc: visd-cctv).

Pi user is visd and services run as that user.

1) Create a least-privilege IAM user (Console)

In the AWS Console: IAM → Users → Create user

Name: visdcam-uploader

Access type: Access key - Programmatic access.

On the Permissions step choose Attach policies directly → Create policy.
Use this JSON policy (replace visd-cctv with your bucket name if different):

{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::visd-cctv"]
    },
    {
      "Sid": "UploadObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListBucketMultipartUploads",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": ["arn:aws:s3:::visd-cctv/*"]
    }
  ]
}


Notes

We don’t grant DeleteObject (uploads only).

Multipart permissions improve reliability for larger files.

Attach this new policy to the user and finish creation.

Download the credentials CSV (Access key ID + Secret). Store it safely.

2) Install AWS CLI on the Pi
sudo apt-get update
sudo apt-get install -y awscli
aws --version

3) Add credentials for user visd (recommended)

Create the shared credentials/config as the visd user:

sudo -u visd mkdir -p /home/visd/.aws
sudo -u visd bash -c 'cat > /home/visd/.aws/credentials <<EOF
[default]
aws_access_key_id=REPLACE_WITH_YOUR_KEY_ID
aws_secret_access_key=REPLACE_WITH_YOUR_SECRET
EOF'
sudo -u visd bash -c 'cat > /home/visd/.aws/config <<EOF
[default]
region=ap-south-1
output=json
EOF'
sudo chown -R visd:visd /home/visd/.aws
chmod 700 /home/visd/.aws
chmod 600 /home/visd/.aws/credentials /home/visd/.aws/config


Why this location?
Our systemd units run the uploader as User=visd, so the AWS CLI will automatically read /home/visd/.aws/* with the default profile. No environment variables are required.

4) Verify the credentials (as visd)
sudo -u visd aws sts get-caller-identity
sudo -u visd aws configure list
sudo -u visd aws s3 ls s3://visd-cctv


You should see your AWS account in get-caller-identity and your bucket listed (or an empty listing with just PRE cam1/, etc.).

5) Ensure systemd services run as visd

Both uploader units should specify User=visd (segmenters already do). Check and fix if needed:

grep -n 'User=' /etc/systemd/system/uploader-cam*.service


If missing or different, edit each uploader unit so the [Service] block includes:

User=visd


Then reload and restart:

sudo systemctl daemon-reload
sudo systemctl restart uploader-cam1.service uploader-cam2.service

6) Troubleshooting quick checks

Uploads not happening?

sudo -u visd aws sts get-caller-identity must work.

journalctl -u uploader-cam1.service -f (and cam2) for live logs.

The uploader scripts assume aws is on PATH for user visd (Debian package installs to /usr/bin/aws—OK).

Accidentally running anything as root?
If you ever run uploaders as root, they’ll look for /root/.aws. Either avoid that, or copy the same files to /root/.aws as well (not recommended—keep everything under visd).

Rotating keys
Update /home/visd/.aws/credentials, then sudo systemctl restart uploader-cam1 uploader-cam2.

Locking down further (optional)
You can add a bucket policy to allow PutObject only from your IAM user, or restrict by VPC endpoint/public IP if you have a static IP.

7) One-liner to rehydrate creds on a fresh Pi

Replace placeholders and run once:

sudo -u visd bash -c 'mkdir -p ~/.aws && \
cat > ~/.aws/credentials <<EOF
[default]
aws_access_key_id=AKIA................
aws_secret_access_key=................................
EOF
cat > ~/.aws/config <<EOF
[default]
region=ap-south-1
output=json
EOF
chmod 600 ~/.aws/credentials ~/.aws/config'


With this in place, your visdcam services will automatically use the correct AWS credentials after each boot, with minimal privileges and no extra runtime overhead.
