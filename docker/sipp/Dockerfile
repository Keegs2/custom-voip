FROM python:3.12-slim-bookworm

# Install SIPp
RUN apt-get update && \
    apt-get install -y --no-install-recommends sip-tester && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir fastapi uvicorn

# Copy the API script
COPY sipp_api.py /app/sipp_api.py
WORKDIR /app

EXPOSE 8001

CMD ["uvicorn", "sipp_api:app", "--host", "0.0.0.0", "--port", "8001"]
