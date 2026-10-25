# vm-forwarder — replays voicemail FreeSWITCH sealed to the spool during an
# East outage (docs/VOICEMAIL_OUTAGE_RESILIENCE.md). Python stdlib only: no
# pip packages, no keys, no openssl — it moves ciphertext it cannot read.
#
# Runs as root INSIDE the container on purpose: the spool files (written by
# FreeSWITCH, root, 0600) and /run/revup/vm_ingest.header (root:root 0600)
# are only readable by their owner. docker-compose.media.yml drops every
# capability (cap_drop: ALL), mounts the root filesystem read-only and sets
# no-new-privileges, so "root" here is an unprivileged owner of those files.
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY forwarder.py /app/forwarder.py

# -I: isolated mode (no user site, no PYTHON* env, script dir not on sys.path).
ENTRYPOINT ["python3", "-I", "/app/forwarder.py"]
