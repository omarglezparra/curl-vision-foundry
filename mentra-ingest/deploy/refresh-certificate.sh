#!/bin/sh
set -eu

app_root=/opt/ai-javier-ingest
env_file="$app_root/app/.env"
domain=$(sed -n 's/^RTMPS_DOMAIN=//p' "$env_file" | tail -n 1)
if [ -z "$domain" ]; then
  echo "RTMPS_DOMAIN is missing from $env_file" >&2
  exit 1
fi

install -d -o root -g 10001 -m 0750 "$app_root/certs"
install -o root -g 10001 -m 0640 "/etc/letsencrypt/live/$domain/fullchain.pem" "$app_root/certs/server.crt"
install -o root -g 10001 -m 0640 "/etc/letsencrypt/live/$domain/privkey.pem" "$app_root/certs/server.key"

if docker compose -f "$app_root/app/compose.production.yml" ps --status running --quiet | grep -q .; then
  docker compose -f "$app_root/app/compose.production.yml" restart ingest
fi
