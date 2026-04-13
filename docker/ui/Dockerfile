# Multi-stage build: React app with Vite → nginx serve

# Stage 1: Extract Homer's entire dist and patch index.html.
# We copy ALL static assets (JS chunks, CSS, fonts, i18n, etc.) into the UI
# container so nginx serves them directly as static files — no proxy hop for
# Homer's frontend assets. Only /api/v3/ calls are still proxied to homer-webapp.
# This eliminates the GCP LB caching/MIME issue: static files served by nginx
# always get the correct Content-Type regardless of what the LB does.
FROM ghcr.io/sipcapture/homer-app AS homer-source
RUN sed -i 's|// PREFIX: "/dist/homer-ui/",|PREFIX: "/homer/", APIURL: "/api/v3",|g' /usr/local/homer/dist/index.html

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
# Copy Homer's entire dist into homer/ so all assets are served as static files.
# index.html is already patched with PREFIX: "/homer/" so base href resolves to
# /homer/ — matching exactly where we place the files on disk.
COPY --from=homer-source /usr/local/homer/dist /usr/share/nginx/html/homer
EXPOSE 80
