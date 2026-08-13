FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLCONFIGDIR=/tmp/matplotlib
WORKDIR /app

COPY azure/processor/requirements.txt ./requirements.txt
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
        libxcb1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir --requirement requirements.txt \
    && groupadd --gid 10001 coach \
    && useradd --uid 10001 --gid coach --no-create-home --shell /usr/sbin/nologin coach

COPY src/azure_capture_uploader.py ./
COPY src/curl_rules.py ./
COPY src/pose_processing.py ./
COPY src/process_azure_captures.py ./
COPY src/video_geometry.py ./
COPY azure/processor/run_scheduled_processor.py ./

RUN mkdir -p /app/models /app/outputs /tmp/matplotlib \
    && python -c "from pose_processing import ensure_pose_model; ensure_pose_model('/app/models/pose_landmarker_lite.task')" \
    && chown -R coach:coach /app /tmp/matplotlib

USER coach
CMD ["python", "run_scheduled_processor.py", "--incremental", "--model-path", "/app/models/pose_landmarker_lite.task", "--output-dir", "/app/outputs", "--frame-stride", "3"]
