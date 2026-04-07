FROM nginx:alpine

# Remove the default nginx config and welcome page
RUN rm /etc/nginx/conf.d/default.conf

# Copy our nginx site config
COPY nginx.conf /etc/nginx/conf.d/rcf-ui.conf

# Copy the single-page app
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 80

# nginx image already has the right CMD/ENTRYPOINT
