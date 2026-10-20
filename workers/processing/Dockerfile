# Reconstruction needs camera/mesh tooling, but no PyTorch or detector weights.
FROM ubuntu:22.04 AS reconstruction
ENV DEBIAN_FRONTEND=noninteractive UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/worker
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3-pip python3.10-venv ffmpeg ca-certificates libgomp1 libglib2.0-0 \
    && python3.10 -m pip install --no-cache-dir uv==0.9.5 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY felslager_processing ./felslager_processing
COPY presets ./presets
ENV UV_HTTP_TIMEOUT=600 UV_CONCURRENT_DOWNLOADS=4 UV_CACHE_DIR=/var/cache/uv
RUN --mount=type=cache,target=/var/cache/uv uv sync --locked --no-dev \
    && useradd --uid 1000 --create-home worker \
    && mkdir -p /srv/felslager/content /srv/felslager-private/bolt-jobs \
    && chown -R worker:worker /srv/felslager /srv/felslager-private
USER worker
ENTRYPOINT ["python", "-m", "felslager_processing"]
CMD ["--role", "reconstruction", "--engine", "odm"]

FROM reconstruction AS detection
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/var/cache/uv uv sync --locked --no-dev --extra detection
COPY models/bolt_detector_v3_yolo26s.pt ./models/bolt_detector_v3_yolo26s.pt
RUN python -c "from pathlib import Path; p=Path('models/bolt_detector_v3_yolo26s.pt'); assert p.stat().st_size > 1000000, 'Run git lfs pull before building the detection image'"
ENV BOLT_MODEL_PATH=/app/models/bolt_detector_v3_yolo26s.pt
USER worker
CMD ["--role", "detection"]

# Bind-mount the extracted official Linux distribution at MESHROOM_HOME.
FROM reconstruction AS meshroom
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libegl1 libx11-6 libx11-xcb1 libxcb1 libxrender1 libxi6 libxkbcommon0 \
    libsm6 libice6 libfontconfig1 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*
ENV MESHROOM_HOME=/opt/meshroom QT_QPA_PLATFORM=offscreen
USER worker
CMD ["--role", "reconstruction", "--engine", "meshroom"]

# Supply Epic's Linux .deb via the separate realityscan-installer build context.
FROM reconstruction AS realityscan
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bzip2 xz-utils x11-apps xvfb xauth libgtk-3-0 libdbus-glib-1-2 libxt6 \
    libx11-xcb1 libxcb-shm0 libxcb-dri3-0 libvulkan1 vulkan-tools \
    libxcomposite1 libasound2 \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=bind,from=realityscan-installer,target=/installer \
    apt-get update && apt-get install -y /installer/*.deb \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/lib/realityscan && chown worker:worker /var/lib/realityscan
ENV HOME=/var/lib/realityscan REALITYSCAN_CLI=/opt/realityscan/bin/realityscan-cli \
    REALITYSCAN_MODEL_PARAMS=/app/presets/realityscan/model.xml \
    REALITYSCAN_REGISTRATION_PARAMS=/app/presets/realityscan/registration.xml \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics,display
USER worker
ENTRYPOINT ["xvfb-run", "-a", "python", "-m", "felslager_processing"]
CMD ["--role", "reconstruction", "--engine", "realityscan"]
