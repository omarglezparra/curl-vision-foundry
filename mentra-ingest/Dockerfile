FROM bluenviron/mediamtx:1.19.3 AS mediamtx

FROM python:3.13-alpine
RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 coach \
    && adduser -S -D -H -u 10001 -G coach coach
COPY --from=mediamtx /mediamtx /mediamtx
COPY mediamtx.yml /mediamtx.yml
COPY mediamtx.production.yml /mediamtx.production.yml
COPY auth_server.py healthcheck.py upload_segment.py retry_worker.py stream_contract.py entrypoint.sh /app/
RUN mkdir -p /recordings /certs && chown -R coach:coach /recordings /app
USER coach
ENV RECORDINGS_ROOT=/recordings
EXPOSE 1935 1936
HEALTHCHECK --interval=30s --timeout=8s --retries=3 CMD ["python3", "/app/healthcheck.py"]
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
