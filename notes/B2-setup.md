Create B2 bucket visd-cctv in region ca-east-006 (S3 endpoint: https://s3.ca-east-006.backblazeb2.com).

Create “S3 Access Key” (Application Keys → S3 Keys in Backblaze UI), note keyID/secret.

On Pi:

# ~/.aws/credentials
[b2]
aws_access_key_id = <your_b2_key_id>      # looks like 006...0003
aws_secret_access_key = <your_b2_key_secret>

# ~/.aws/config
[profile b2]
region = ca-east-006
s3 =
    signature_version = s3v4
    addressing_style = virtual


Test:

AWS_PROFILE=b2 aws --endpoint-url https://s3.ca-east-006.backblazeb2.com s3 ls s3://visd-cctv/
