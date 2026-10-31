#!/usr/bin/env bash
# Downloads every video object under tenants/ from R2 using rclone (S3-compatible API).
# One-time setup: create an R2 API token (Object Read), then `rclone config` a remote named "r2" (provider Cloudflare).
set -euo pipefail
DEST="${1:-./backups/r2}"
command -v rclone >/dev/null || { echo "Install rclone first: https://rclone.org/install/"; exit 1; }
rclone sync "r2:${R2_BUCKET:-smartmanager-video-assets}" "$DEST" --progress
echo "Synced to $DEST"
