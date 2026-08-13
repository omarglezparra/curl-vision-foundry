#!/bin/sh
set -eu

: "${STREAM_KEY_SECRET:?STREAM_KEY_SECRET is required}"
: "${AZURE_CAPTURE_API_BASE:?AZURE_CAPTURE_API_BASE is required}"
: "${AZURE_INGEST_API_TOKEN:?AZURE_INGEST_API_TOKEN is required}"
python3 /app/upload_segment.py --check-config

mediamtx_config="${MEDIAMTX_CONFIG:-/mediamtx.yml}"
if [ ! -r "$mediamtx_config" ]; then
  echo "MediaMTX configuration is not readable: $mediamtx_config" >&2
  exit 1
fi

if [ "${INGEST_HEALTHCHECK_MODE:-rtmp}" = "rtmps" ]; then
  : "${RTMPS_DOMAIN:?RTMPS_DOMAIN is required for production RTMPS}"
  if [ ! -r /certs/server.crt ] || [ ! -r /certs/server.key ]; then
    echo "RTMPS requires readable /certs/server.crt and /certs/server.key files." >&2
    exit 1
  fi
fi

mkdir -p "${RECORDINGS_ROOT:-/recordings}"
# Plain MP4s from an earlier container run are closed because MediaMTX has not
# started yet. Mark them for retry before a new live segment can appear.
python3 /app/retry_worker.py --queue-existing
python3 /app/auth_server.py &
python3 /app/retry_worker.py &
exec /mediamtx "$mediamtx_config"
