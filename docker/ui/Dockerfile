# Multi-stage build: React app with Vite → nginx serve

# Stage 1: Build the React SPA
FROM node:20-alpine AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ .
RUN npm run build

# Stage 2: Assemble the final nginx image
FROM nginx:alpine
RUN rm /etc/nginx/conf.d/default.conf

# Generate a self-signed TLS certificate at build time.
# WebRTC requires HTTPS for getUserMedia (camera/microphone access).
# 10-year validity — rebuild the image to rotate.
RUN apk add --no-cache openssl && \
    mkdir -p /etc/nginx/ssl && \
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout /etc/nginx/ssl/server.key \
      -out /etc/nginx/ssl/server.crt \
      -subj "/CN=voiceplatform.local"

COPY nginx-maps.conf /etc/nginx/conf.d/00-maps.conf
COPY nginx.conf /etc/nginx/conf.d/rcf-ui.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80 443
