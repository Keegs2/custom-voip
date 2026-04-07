# High-Performance FastAPI for Voice Platform
# Multi-stage build to minimize final image size

# =============================================================================
# Stage 1: Builder - compile dependencies that need build tools
# =============================================================================
FROM python:3.12-slim-bookworm AS builder

WORKDIR /build

# Install build dependencies in a single layer with immediate cleanup
# Using --mount=type=cache would be ideal but not all Docker versions support it
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        libffi-dev \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/archives/*

# Create virtual environment for clean dependency isolation
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Upgrade pip and install wheel for faster installs
RUN pip install --no-cache-dir --upgrade pip wheel

# Copy and install requirements
# Using --prefer-binary to use pre-built wheels when available
COPY requirements.txt .
RUN pip install --no-cache-dir --prefer-binary -r requirements.txt

# =============================================================================
# Stage 2: Runtime - minimal image with only what's needed to run
# =============================================================================
FROM python:3.12-slim-bookworm AS runtime

WORKDIR /app

# Install only runtime dependencies (if any needed)
# Most Python packages with C extensions include their libs in wheels
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libffi8 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/archives/* \
    && apt-get clean

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application code
COPY src/ /app/

# Create non-root user for security
RUN useradd -m -u 1000 api && chown -R api:api /app
USER api

EXPOSE 8000

# Use uvicorn with multiple workers for performance
# uvloop and httptools provide significant performance gains
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4", "--loop", "uvloop", "--http", "httptools"]
