# CRAG Visual IVR — internal Piper text-to-speech sidecar (services VM only).
# Contract: docs/IVR_INTERFACES.md §8.1. CPU only, services-network only
# (NO published port). Voices are downloaded + sha256-verified at BUILD time
# (fetch_voices.py / voices.json); the running container never fetches.
#
# Licences: piper-tts is GPL-3.0-or-later (it bundles espeak-ng, GPL-3.0); it
# runs here as an internal network service, unmodified, and is not
# distributed. The three voice models are public domain (voices.json).
FROM python:3.12-slim-bookworm

ARG PIPER_VERSION=1.8.0
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

RUN pip install "piper-tts==${PIPER_VERSION}" \
 && useradd --system --uid 1001 --home-dir /app --shell /usr/sbin/nologin tts

WORKDIR /app
COPY voices.json fetch_voices.py /app/
RUN python /app/fetch_voices.py /app/voices.json /voices && chmod -R a+rX /voices
COPY server.py /app/

USER tts
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5000/health', timeout=4).status==200 else 1)"
CMD ["python", "/app/server.py"]
