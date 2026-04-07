# Test webhook server for API calling tests
FROM python:3.12-slim

WORKDIR /app
COPY webhook_server.py .
RUN pip install --no-cache-dir flask gunicorn

EXPOSE 9000

CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:9000", "webhook_server:app"]
