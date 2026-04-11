# Multi-stage build: React app with Vite → nginx serve

# Stage 1: Extract and patch Homer's index.html so it loads assets from /homer/
# instead of / — this is the only file that needs rewriting; all other asset
# requests go straight to the homer-webapp container without any sub_filter.
FROM ghcr.io/sipcapture/homer-app AS homer-source
RUN sed -i 's|// PREFIX: "/dist/homer-ui/",|PREFIX: "/homer/",|g' /usr/local/homer/dist/index.html

# Stage 2: Build the React SPA
FROM node:20-alpine AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ .
RUN npm run build

# Stage 3: Assemble the final nginx image
FROM nginx:alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx-maps.conf /etc/nginx/conf.d/00-maps.conf
COPY nginx.conf /etc/nginx/conf.d/rcf-ui.conf
COPY --from=build /app/dist /usr/share/nginx/html
# Bake in the patched Homer index.html so nginx serves it as a static file
# for GET /homer/ — no sub_filter needed, immune to GCP LB gzip/caching.
COPY --from=homer-source /usr/local/homer/dist/index.html /usr/share/nginx/html/homer-index.html
EXPOSE 80
