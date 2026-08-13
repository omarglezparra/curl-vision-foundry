# Mentra RTMP ingest

This service completes the Mentra Store recording path. MediaMTX accepts only a
short-lived, nonce-bearing HMAC-signed publisher path, denies readers, records
two-minute fMP4 segments, and uploads each completed segment to the protected
Azure Mentra API.
A segment is deleted after Azure returns 2xx. Failed or interrupted uploads stay
temporarily in the persistent `/recordings` volume with a `.retry` or
`.uploading` suffix and are retried. They are never retained indefinitely: the
worker purges them after 24 hours by default. It deliberately ignores plain
`.mp4` files while MediaMTX is running because those files can still be open for
recording.

For local validation without Docker:

```powershell
python -m unittest discover -s tests -v
python -m compileall -q .
```

For a local container run:

```powershell
Copy-Item .env.example .env
docker compose -f compose.yml config
docker compose -f compose.yml up --build
```

Set the MiniApp `MENTRA_STREAM_BASE_URL` to `rtmp://<reachable-host>:1935`.
Plain RTMP is only for a private development network.

## Ingest credential and local retention

`AZURE_INGEST_API_TOKEN` is a dedicated Bearer credential for only the Azure
`mentra-video` route. It must be a random, non-placeholder value of at least 32
characters. Do not reuse the MiniApp API token or the Mentra webhook/API key;
the legacy `MENTRA_WEBHOOK_TOKEN` variable is intentionally unsupported here.

`FAILED_SEGMENT_RETENTION_SECONDS` controls how long `.retry` and `.uploading`
files may remain locally. It defaults to 86400 seconds (24 hours) and is bounded
to 300-604800 seconds (five minutes to seven days). The worker runs the purge
after queuing closed files at startup and at the beginning of every retry cycle.
Azure HTTP 410 is a terminal `profile deleted` response: the service overwrites
and unlinks that local segment instead of retrying it. Azure must reserve 410 on
this endpoint for that permanent condition.

Every upload includes `captured_at=<unix-seconds>` from the completed segment's
original modification time. Azure can therefore apply retention from capture
time rather than from a delayed retry. Successful, rejected, and purged segments
also have their empty signed-stream directory removed.

The overwrite pass is defense in depth, not a guarantee of physical erasure on
SSDs, copy-on-write storage, or provider snapshots. Encrypt the recording volume
at rest, restrict snapshot retention, and securely decommission the volume.

The retry worker updates `/recordings/.retry-worker-heartbeat` at least every 30
seconds while idle and around each retry. The container health check fails if it
is missing or older than `RETRY_WORKER_HEALTH_MAX_AGE_SECONDS` (300 by default),
in addition to checking the auth and media listeners.

## Signed publisher IDs

The MiniApp and ingest service share this versioned-by-format contract:

```text
ajc_<session>__p_<profile>__r_<rotation>__s_<scene>__m_<source>__e_<expiry>__n_<nonce>__h_<signature>
```

- `expiry` is a Unix timestamp in seconds.
- `nonce` is 16-64 URL-safe characters; the MiniApp emits a fresh 144-bit
  base64url nonce for each stream.
- `signature` is the first 32 lowercase hex characters of HMAC-SHA256 over
  everything before `__h_`, using `STREAM_KEY_SECRET`.
- `MENTRA_STREAM_AUTH_TTL_SECONDS` is the MiniApp's issued lifetime and defaults
  to 14400 seconds. The MiniApp accepts 300-14400 seconds.
- `STREAM_AUTH_MAX_TTL_SECONDS` is the ingest-side maximum and defaults to the
  same 14400 seconds. Keep it greater than or equal to the MiniApp value.
- `STREAM_AUTH_CLOCK_SKEW_SECONDS` defaults to 60 seconds (maximum 300) and is
  applied only to the maximum-future check so small host clock differences do
  not reject a freshly issued credential. Expiry itself remains strict.

The authorization server rejects expired credentials and credentials whose
expiry is too far in the future. Metadata parsing intentionally remains valid
after expiry so a completed segment can upload or retry hours later. Legacy
signed IDs can be parsed only to drain pre-migration recordings; they are never
accepted for a new publish. Treat the full stream path as a credential and keep
it out of logs and support messages.

## Production RTMPS

Production uses the standalone `compose.production.yml` and
`mediamtx.production.yml`. They enable strict RTMPS, publish TCP port 1936 only,
and do not open plaintext port 1935.

1. Point a dedicated DNS name, such as `ingest.example.com`, at the ingest host.
2. Obtain a certificate from a publicly trusted CA with that exact name in its
   subject alternative names. Put the full certificate chain in
   `<RTMPS_CERT_DIR>/server.crt` and its matching unencrypted private key in
   `<RTMPS_CERT_DIR>/server.key`. Restrict the host files to the operator and
   Docker service, while keeping them readable by the non-root container user.
3. Set `RTMPS_DOMAIN`, `RTMPS_CERT_DIR`, `AZURE_CAPTURE_API_BASE`, the dedicated
   `AZURE_INGEST_API_TOKEN`, shared
   `STREAM_KEY_SECRET`, and ingest TTL controls in `.env`. Set the MiniApp's
   corresponding values in its environment. `RTMPS_DOMAIN` must match the
   certificate and the hostname used by the MiniApp.
4. Allow inbound TCP 1936 in the host/cloud firewall. Do not allow TCP 1935.
5. Start the production definition by itself:

```powershell
docker compose -f compose.production.yml config
docker compose -f compose.production.yml up --build -d
```

Set the MiniApp URL to `rtmps://<RTMPS_DOMAIN>:1936/live`. The production health
check verifies the authorization server, the RTMPS listener, the public trust
chain, and the certificate hostname. A self-signed, expired, incomplete-chain,
or wrong-host certificate leaves the container unhealthy. Restart the service
after rotating the mounted certificate files.

The ingest container is intentionally separate from the web MiniApp because it
needs a public TCP media port and persistent disk. An always-on cloud instance
can exceed the project's US$5 Azure budget alert; deploy it on demand or stop it
after the workout. The alert does not impose a hard spending cap.

The Store stream includes microphone audio with the current Mentra SDK. Disclose
that in the Store privacy text, avoid bystanders, define a retention/deletion
policy, and do not expose the recording volume or a playback endpoint.

MediaMTX configuration follows the current official
[recording](https://mediamtx.org/docs/references/configuration-file) and
[segment hook](https://mediamtx.org/docs/features/hooks) references.
