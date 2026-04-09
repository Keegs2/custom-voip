# Multi-stage build: React app with Vite → nginx serve
# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ .
RUN npm run build

# Production stage
FROM nginx:alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/rcf-ui.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
